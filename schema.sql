
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    balance DECIMAL(10, 2) DEFAULT 0,
    join_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_domains INTEGER DEFAULT 0,
    template_type VARCHAR(50) DEFAULT 'html',
    subscription_active BOOLEAN DEFAULT FALSE,
    subscription_start_date TIMESTAMP,
    subscription_end_date TIMESTAMP,
    subscription_domains_used INTEGER DEFAULT 0,
    daily_domains_used INTEGER DEFAULT 0,
    last_domain_date TIMESTAMP,
    has_ever_subscribed BOOLEAN DEFAULT FALSE,
    email VARCHAR(255),
    username VARCHAR(255),
    notifications VARCHAR(50) DEFAULT 'all',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Domain history table
CREATE TABLE IF NOT EXISTS history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    redirect_url TEXT NOT NULL,
    urls JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_history_user_id ON history(user_id);
CREATE INDEX IF NOT EXISTS idx_history_domain ON history(domain);

-- Click tracking table
CREATE TABLE IF NOT EXISTS clicks (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clicks_domain ON clicks(domain);
CREATE INDEX IF NOT EXISTS idx_clicks_clicked_at ON clicks(clicked_at);

-- Payment requests table
CREATE TABLE IF NOT EXISTS payment_requests (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    request_id VARCHAR(100) UNIQUE NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    proof_url TEXT,
    transaction_hash TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP,
    rejected_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_user_id ON payment_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_request_id ON payment_requests(request_id);

-- Topups table
CREATE TABLE IF NOT EXISTS topups (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    transaction_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topups_user_id ON topups(user_id);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status);

-- Template reference images table
CREATE TABLE IF NOT EXISTS template_reference_images (
    template_type VARCHAR(50) PRIMARY KEY,
    file_id TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Support tickets table
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
