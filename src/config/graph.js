// Microsoft Graph API client
// This is the module that talks to OneDrive / SharePoint on your behalf.
// It uses your Azure App Registration credentials to get an access token,
// then uses that token to upload, download, and organize files.

const logger = require('../utils/logger');

// ── Token cache (tokens last ~60 min, so we reuse them)
let cachedToken = null;
let tokenExpiry  = 0;

/**
 * Get a valid Microsoft Graph access token.
 * Uses "client credentials" flow — your backend talks to Microsoft directly,
 * no user login needed.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60_000) {
    return cachedToken; // reuse if still valid
  }

  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error(
      'Missing Azure credentials. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, ' +
      'and AZURE_CLIENT_SECRET in your Railway environment variables.'
    );
  }

  const url  = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope:         'https://graph.microsoft.com/.default',
  });

  const res  = await fetch(url, { method: 'POST', body });
  const data = await res.json();

  if (!res.ok || !data.access_token) {
    logger.error('Failed to get Microsoft Graph token', { error: data });
    throw new Error(`Azure auth failed: ${data.error_description || data.error}`);
  }

  cachedToken = data.access_token;
  tokenExpiry  = now + (data.expires_in * 1000);

  logger.info('Microsoft Graph token refreshed');
  return cachedToken;
}

/**
 * Make an authenticated call to the Microsoft Graph API.
 * @param {string} method  - HTTP method
 * @param {string} path    - Graph API path (e.g. /sites/{id}/drive/items/{id}/children)
 * @param {object} options - fetch options (body, headers, etc.)
 */
async function graphRequest(method, path, options = {}) {
  const token = await getAccessToken();
  const base  = 'https://graph.microsoft.com/v1.0';

  const res = await fetch(`${base}${path}`, {
    method,
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  // 204 No Content = success with no body (e.g. delete, move)
  if (res.status === 204) return null;

  const data = await res.json();

  if (!res.ok) {
    logger.error('Graph API error', { path, status: res.status, error: data });
    throw new Error(
      data?.error?.message || `Graph API error ${res.status} on ${path}`
    );
  }

  return data;
}

// ── SharePoint site helpers ───────────────────────────────────────────────────

/**
 * Get the SharePoint site ID for your DocVault site.
 * Cached after first call.
 */
let cachedSiteId = null;

async function getSiteId() {
  if (cachedSiteId) return cachedSiteId;

  const hostname  = process.env.SHAREPOINT_HOSTNAME;  // e.g. harborfinance.sharepoint.com
  const sitePath  = process.env.SHAREPOINT_SITE_PATH; // e.g. /sites/DocVault

  if (!hostname || !sitePath) {
    throw new Error(
      'Missing SHAREPOINT_HOSTNAME or SHAREPOINT_SITE_PATH env vars.'
    );
  }

  const data = await graphRequest('GET', `/sites/${hostname}:${sitePath}`);
  cachedSiteId = data.id;
  logger.info('SharePoint site ID cached', { siteId: cachedSiteId });
  return cachedSiteId;
}

/**
 * Get the root drive ID for the SharePoint site's document library.
 */
let cachedDriveId = null;

async function getDriveId() {
  if (cachedDriveId) return cachedDriveId;
  const siteId = await getSiteId();
  const data   = await graphRequest('GET', `/sites/${siteId}/drive`);
  cachedDriveId = data.id;
  return cachedDriveId;
}

// ── Folder management ─────────────────────────────────────────────────────────

/**
 * Ensure a folder exists in SharePoint. Creates it if it doesn't exist.
 * Returns the folder's OneDrive item ID.
 *
 * @param {string} folderPath - e.g. "Clients/Acme Corp/Bank Statements"
 */
async function ensureFolder(folderPath) {
  const driveId = await getDriveId();

  // Walk the path, creating each segment if needed
  const segments = folderPath.split('/').filter(Boolean);
  let parentId   = 'root';

  for (const segment of segments) {
    try {
      // Try to get the existing folder
      const existing = await graphRequest(
        'GET',
        `/drives/${driveId}/items/${parentId}:/${encodeURIComponent(segment)}`
      );
      parentId = existing.id;
    } catch {
      // Folder doesn't exist — create it
      const created = await graphRequest(
        'POST',
        `/drives/${driveId}/items/${parentId}/children`,
        {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name:                              segment,
            folder:                            {},
            '@microsoft.graph.conflictBehavior': 'rename',
          }),
        }
      );
      parentId = created.id;
      logger.info(`Created SharePoint folder: ${segment}`);
    }
  }

  return parentId;
}

// ── File upload ───────────────────────────────────────────────────────────────

/**
 * Upload a file to a specific SharePoint folder.
 * Uses the "upload session" API for files up to 250MB.
 *
 * @param {Buffer} fileBuffer   - The file content
 * @param {string} fileName     - Name to save it as in SharePoint
 * @param {string} folderItemId - OneDrive item ID of the destination folder
 * @param {string} mimeType     - e.g. "application/pdf"
 * @returns {object} The created OneDrive file item (includes id, webUrl, etc.)
 */
async function uploadFile(fileBuffer, fileName, folderItemId, mimeType) {
  const driveId = await getDriveId();

  // For files under 4MB, use simple upload
  if (fileBuffer.length < 4 * 1024 * 1024) {
    return graphRequest(
      'PUT',
      `/drives/${driveId}/items/${folderItemId}:/${encodeURIComponent(fileName)}:/content`,
      {
        headers: { 'Content-Type': mimeType },
        body:    fileBuffer,
      }
    );
  }

  // For larger files, create an upload session first
  const session = await graphRequest(
    'POST',
    `/drives/${driveId}/items/${folderItemId}:/${encodeURIComponent(fileName)}:/createUploadSession`,
    {
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': 'rename',
          name: fileName,
        },
      }),
    }
  );

  // Upload in 4MB chunks
  const chunkSize  = 4 * 1024 * 1024;
  const totalBytes = fileBuffer.length;
  let   uploadedItem = null;

  for (let start = 0; start < totalBytes; start += chunkSize) {
    const end   = Math.min(start + chunkSize, totalBytes);
    const chunk = fileBuffer.slice(start, end);

    const token = await getAccessToken();
    const res   = await fetch(session.uploadUrl, {
      method:  'PUT',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Length': `${chunk.length}`,
        'Content-Range':  `bytes ${start}-${end - 1}/${totalBytes}`,
      },
      body: chunk,
    });

    const data = await res.json();
    if (res.status === 201 || res.status === 200) {
      uploadedItem = data; // final chunk returns the complete item
    }
  }

  return uploadedItem;
}

// ── Download (signed URL) ─────────────────────────────────────────────────────

/**
 * Get a short-lived download URL for a OneDrive file.
 * The URL is valid for ~1 hour and requires no authentication to use.
 *
 * @param {string} oneDriveItemId - The OneDrive file item ID
 */
async function getDownloadUrl(oneDriveItemId) {
  const driveId = await getDriveId();
  const item    = await graphRequest(
    'GET',
    `/drives/${driveId}/items/${oneDriveItemId}?select=id,name,@microsoft.graph.downloadUrl`
  );
  // The @microsoft.graph.downloadUrl is a pre-authenticated short-lived URL
  return item['@microsoft.graph.downloadUrl'];
}

// ── Client folder setup ───────────────────────────────────────────────────────

/**
 * Create the standard folder structure for a new client in SharePoint.
 * Called automatically when a new client is added in DocVault.
 *
 * Structure created:
 *   Clients/
 *     {Client Name}/
 *       Bank Statements/
 *       Invoices/
 *       Tax Documents/
 *       Payroll/
 *       Contracts/
 *       Other/
 *
 * @param {string} clientName - The company name
 * @returns {string} The OneDrive item ID of the client's root folder
 */
async function setupClientFolder(clientName) {
  const safeName    = clientName.replace(/[/\\:*?"<>|]/g, '-'); // strip chars invalid in folder names
  const clientPath  = `Clients/${safeName}`;
  const subFolders  = [
    'Bank Statements',
    'Invoices',
    'Tax Documents',
    'Payroll',
    'Contracts',
    'Other',
  ];

  // Create the client root folder
  const clientFolderId = await ensureFolder(clientPath);

  // Create all subfolders in parallel
  await Promise.all(
    subFolders.map(sub => ensureFolder(`${clientPath}/${sub}`))
  );

  logger.info(`SharePoint folders created for client: ${clientName}`);
  return clientFolderId;
}

module.exports = {
  graphRequest,
  ensureFolder,
  uploadFile,
  getDownloadUrl,
  setupClientFolder,
  getSiteId,
  getDriveId,
};
