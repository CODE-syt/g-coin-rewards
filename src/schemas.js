'use strict';

const { z } = require('zod');
const { VOUCHER_MODES } = require('./constants');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const emptyToNull = (v) => (v === '' ? null : v);

const rewardFields = {
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(1).max(2000),
  imageUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https:\/\/[^\s]+$/i.test(v) || /^\/img\/[A-Za-z0-9._\/-]+$/.test(v), 'Image must be an https:// URL'),
  price: z.number().int().min(1).max(1_000_000),
  status: z.enum(['active', 'inactive']),
  voucherMode: z.enum(VOUCHER_MODES),
  stock: z.preprocess(emptyToNull, z.number().int().min(0).max(1_000_000).nullable()),
  perUserLimit: z.preprocess(emptyToNull, z.number().int().min(1).max(1000).nullable()),
  startsAt: z.preprocess(emptyToNull, z.coerce.date().nullable()),
  endsAt: z.preprocess(emptyToNull, z.coerce.date().nullable()),
  redemptionDetails: z.string().trim().max(2000),
  sortOrder: z.number().int().min(-1000).max(100000),
};

const rewardCreate = z
  .object({
    ...rewardFields,
    imageUrl: rewardFields.imageUrl.optional(),
    status: rewardFields.status.optional(),
    voucherMode: rewardFields.voucherMode.optional(),
    stock: rewardFields.stock.optional(),
    perUserLimit: rewardFields.perUserLimit.optional(),
    startsAt: rewardFields.startsAt.optional(),
    endsAt: rewardFields.endsAt.optional(),
    redemptionDetails: rewardFields.redemptionDetails.optional(),
    sortOrder: rewardFields.sortOrder.optional(),
  })
  .strict();

const rewardUpdate = z.object(rewardFields).partial().strict();

const adminLogin = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
  code: z.string().trim().max(10).optional(),
});

const reauth = z.object({ confirmPassword: z.string().min(1).max(200), confirmCode: z.string().trim().max(10).optional() });

const voucherAdd = z.object({ codes: z.array(z.string().max(200)).min(1).max(1000) });

const pageQuery = z.object({ page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional() });

const devLogin = z.object({ email: z.string().trim().email().max(320), name: z.string().trim().min(1).max(100).optional() });

const chatBody = (maxChars) =>
  z.object({
    message: z.string().trim().min(1, 'Please type a question').max(maxChars, `Please keep your message under ${maxChars} characters`),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(maxChars) }))
      .max(12)
      .optional(),
  });

const shareCreate = z.object({ rewardId: objectId, channel: z.string().trim().max(30).optional() });

module.exports = { objectId, rewardCreate, rewardUpdate, adminLogin, reauth, voucherAdd, pageQuery, devLogin, chatBody, shareCreate };
