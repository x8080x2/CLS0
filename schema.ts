import { pgTable, bigint, integer, varchar, boolean, timestamp, jsonb, serial, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  balance: integer('balance').default(0),
  joinDate: timestamp('join_date').defaultNow(),
  totalDomains: integer('total_domains').default(0),
  templateType: varchar('template_type').default('html'),
  subscriptionActive: boolean('subscription_active').default(false),
  subscriptionStartDate: timestamp('subscription_start_date'),
  subscriptionEndDate: timestamp('subscription_end_date'),
  subscriptionDomainsUsed: integer('subscription_domains_used').default(0),
  dailyDomainsUsed: integer('daily_domains_used').default(0),
  lastDomainDate: timestamp('last_domain_date'),
  hasEverSubscribed: boolean('has_ever_subscribed').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const history = pgTable('history', {
  id: serial('id').primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  domain: varchar('domain').notNull(),
  redirectUrl: varchar('redirect_url').notNull(),
  urls: jsonb('urls').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  userIdIdx: index('history_user_id_idx').on(table.userId),
}));

export const clicks = pgTable('clicks', {
  id: serial('id').primaryKey(),
  domain: varchar('domain').notNull(),
  ipAddress: varchar('ip_address'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  domainIdx: index('clicks_domain_idx').on(table.domain),
}));

export const topups = pgTable('topups', {
  id: serial('id').primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  amount: integer('amount').notNull(),
  transactionId: varchar('transaction_id'),
  status: varchar('status').default('completed'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  userIdIdx: index('topups_user_id_idx').on(table.userId),
}));

export const paymentRequests = pgTable('payment_requests', {
  id: serial('id').primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id).notNull(),
  requestId: varchar('request_id').notNull().unique(),
  amount: integer('amount').notNull(),
  proofUrl: varchar('proof_url'),
  transactionHash: varchar('transaction_hash'),
  status: varchar('status').default('pending').notNull(),
  approvedAt: timestamp('approved_at'),
  rejectedAt: timestamp('rejected_at'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  userIdIdx: index('payment_requests_user_id_idx').on(table.userId),
  requestIdIdx: index('payment_requests_request_id_idx').on(table.requestId),
  statusIdx: index('payment_requests_status_idx').on(table.status),
}));
