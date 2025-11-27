
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id BIGINT PRIMARY KEY,
    username VARCHAR(255),
    email VARCHAR(255),
    balance DECIMAL(10, 2) DEFAULT 0,
    join_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_domains INTEGER DEFAULT 0,
    template_type VARCHAR(50) DEFAULT 'html',
    subscription_active BOOLEAN DEFAULT FALSE,
    subscription_start_date TIMESTAMP,
    subscription_end_date TIMESTAMP,
    subscription_domains_used INTEGER DEFAULT 0,
    subscription_daily_domains_used INTEGER DEFAULT 0,
    subscription_last_domain_date TIMESTAMP,
    subscription_has_ever_subscribed BOOLEAN DEFAULT FALSE,
    notifications JSONB DEFAULT '{"email": true, "telegram": true}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- History table (domain provisioning records)
CREATE TABLE IF NOT EXISTS history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain VARCHAR(255) NOT NULL,
    redirect_url TEXT NOT NULL,
    urls JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_domain (domain)
);

-- Clicks tracking table
CREATE TABLE IF NOT EXISTS clicks (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    referrer TEXT,
    clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_domain (domain),
    INDEX idx_clicked_at (clicked_at)
);

-- Payment requests table
CREATE TABLE IF NOT EXISTS payment_requests (
    id VARCHAR(50) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    crypto_type VARCHAR(50),
    proof_url TEXT,
    transaction_hash TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    approved_at TIMESTAMP,
    rejected_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status)
);

-- Topups table
CREATE TABLE IF NOT EXISTS topups (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    crypto_type VARCHAR(50),
    transaction_hash TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status)
);

-- Template reference images table
CREATE TABLE IF NOT EXISTS template_images (
    template_type VARCHAR(50) PRIMARY KEY,
    file_id TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Support tickets table
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status)
);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to users table
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to support_tickets table
DROP TRIGGER IF EXISTS update_support_tickets_updated_at ON support_tickets;
CREATE TRIGGER update_support_tickets_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
