const { z } = require('zod');

// ── All valid roles
const VALID_ROLES = ['owner', 'manager', 'staff_accountant', 'readonly_reviewer', 'client'];
const INTERNAL_ROLES = ['owner', 'manager', 'staff_accountant', 'readonly_reviewer'];

// ── Reusable primitives
const uuidParam = z.string().uuid();
const paginationQuery = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Auth
const registerClientBody = z.object({
  email:        z.string().email().max(255),
  password:     z.string().min(8).max(128),
  full_name:    z.string().min(1).max(255),
  company_name: z.string().max(255).optional(),
  client_id:    uuidParam,
});

const inviteBody = z.object({
  email: z.string().email().max(255),
});

// ── Clients
const createClientBody = z.object({
  name:     z.string().min(1).max(255),
  industry: z.string().max(255).optional(),
  email:    z.string().email().max(255),
  phone:    z.string().max(50).optional(),
  address:  z.string().max(500).optional(),
});

const updateClientBody = z.object({
  name:          z.string().min(1).max(255).optional(),
  industry:      z.string().max(255).optional(),
  phone:         z.string().max(50).optional(),
  address:       z.string().max(500).optional(),
  portal_active: z.boolean().optional(),
});

// ── Documents
const uploadDocumentBody = z.object({
  client_id:     uuidParam,
  folder_id:     uuidParam.optional(),
  tags:          z.string().optional(),
  upload_source: z.enum(['web', 'mobile', 'mobile_scan']).default('web'),
});

const documentListQuery = paginationQuery.extend({
  client_id: uuidParam.optional(),
  folder_id: uuidParam.optional(),
  status:    z.enum(['pending', 'in_review', 'approved', 'flagged', 'archived']).optional(),
});

const updateStatusBody = z.object({
  status:      z.enum(['in_review', 'approved', 'flagged', 'archived']),
  review_note: z.string().max(2000).optional(),
});

// ── Folders
const createFolderBody = z.object({
  client_id:   uuidParam,
  name:        z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
});

const folderListQuery = z.object({
  client_id: uuidParam.optional(),
});

// ── Requests
const createRequestBody = z.object({
  client_id:   uuidParam,
  folder_id:   uuidParam.optional(),
  title:       z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  due_date:    z.string().date().optional(),
});

const fulfillRequestBody = z.object({
  document_id: uuidParam,
});

const requestListQuery = z.object({
  client_id: uuidParam.optional(),
  status:    z.enum(['open', 'fulfilled', 'cancelled']).optional(),
});

// ── Audit
const auditListQuery = paginationQuery.extend({
  client_id:   uuidParam.optional(),
  document_id: uuidParam.optional(),
});

// ── Staff management (owner only)
const registerStaffBody = z.object({
  email:     z.string().email().max(255),
  password:  z.string().min(8).max(128),
  full_name: z.string().min(1).max(255),
  role:      z.enum(['manager', 'staff_accountant', 'readonly_reviewer']),
});

const assignStaffBody = z.object({
  user_id:   uuidParam,
  client_id: uuidParam,
});

const staffListQuery = z.object({
  role: z.enum(['owner', 'manager', 'staff_accountant', 'readonly_reviewer']).optional(),
});

// ── Pending actions
const createPendingActionBody = z.object({
  action_type: z.enum(['flag_document', 'request_upload', 'create_folder']),
  client_id:   uuidParam,
  document_id: uuidParam.optional(),
  payload:     z.object({
    reason:      z.string().max(2000).optional(),
    title:       z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    folder_name: z.string().max(255).optional(),
    due_date:    z.string().date().optional(),
  }),
});

const reviewPendingActionBody = z.object({
  status:      z.enum(['approved', 'rejected']),
  review_note: z.string().max(2000).optional(),
});

const pendingActionsListQuery = paginationQuery.extend({
  status:    z.enum(['pending', 'approved', 'rejected']).optional(),
  client_id: uuidParam.optional(),
});

// ── Helper: validate and return parsed data or send 400
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    req.query = result.data;
    next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid route parameters' });
    }
    req.params = result.data;
    next();
  };
}

const idParam = z.object({ id: uuidParam });

module.exports = {
  validate,
  validateQuery,
  validateParams,
  idParam,
  registerClientBody,
  inviteBody,
  createClientBody,
  updateClientBody,
  uploadDocumentBody,
  documentListQuery,
  updateStatusBody,
  createFolderBody,
  folderListQuery,
  createRequestBody,
  fulfillRequestBody,
  requestListQuery,
  auditListQuery,
  registerStaffBody,
  assignStaffBody,
  staffListQuery,
  createPendingActionBody,
  reviewPendingActionBody,
  pendingActionsListQuery,
  VALID_ROLES,
  INTERNAL_ROLES,
};
