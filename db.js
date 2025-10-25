const { Pool } = require('pg');

// Database connection pool (using Neon PostgreSQL - works on both Replit and Render)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_gkbAPU7aWF3Y@ep-raspy-brook-a150lned-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Test connection on startup
pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
});

// User operations
async function loadUserData(userId) {
    try {
        if (!userId || (typeof userId !== 'number' && typeof userId !== 'string')) {
            console.error('Invalid userId provided to loadUserData:', userId);
            return null;
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const user = result.rows[0];
        return {
            id: user.id,
            balance: user.balance,
            joinDate: user.join_date,
            totalDomains: user.total_domains,
            templateType: user.template_type || 'html',
            subscription: {
                active: user.subscription_active,
                startDate: user.subscription_start_date,
                endDate: user.subscription_end_date,
                domainsUsed: user.subscription_domains_used,
                dailyDomainsUsed: user.daily_domains_used || 0,
                lastDomainDate: user.last_domain_date,
                hasEverSubscribed: user.has_ever_subscribed || false
            }
        };
    } catch (error) {
        console.error(`Error loading user data for ${userId}:`, error);
        return null;
    }
}

async function saveUserData(userId, userData) {
    try {
        if (!userId || (typeof userId !== 'number' && typeof userId !== 'string')) {
            console.error('Invalid userId provided to saveUserData:', userId);
            return false;
        }

        if (!userData || typeof userData !== 'object') {
            console.error('Invalid userData provided to saveUserData:', userData);
            return false;
        }

        await pool.query(`
            INSERT INTO users (
                id, balance, join_date, total_domains, template_type,
                subscription_active, subscription_start_date, 
                subscription_end_date, subscription_domains_used,
                daily_domains_used, last_domain_date, has_ever_subscribed,
                updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
            ON CONFLICT (id) DO UPDATE SET
                balance = $2,
                join_date = $3,
                total_domains = $4,
                template_type = $5,
                subscription_active = $6,
                subscription_start_date = $7,
                subscription_end_date = $8,
                subscription_domains_used = $9,
                daily_domains_used = $10,
                last_domain_date = $11,
                has_ever_subscribed = $12,
                updated_at = CURRENT_TIMESTAMP
        `, [
            userId,
            userData.balance || 0,
            userData.joinDate || new Date(),
            userData.totalDomains || 0,
            userData.templateType || 'html',
            userData.subscription?.active || false,
            userData.subscription?.startDate || null,
            userData.subscription?.endDate || null,
            userData.subscription?.domainsUsed || 0,
            userData.subscription?.dailyDomainsUsed || 0,
            userData.subscription?.lastDomainDate || null,
            userData.subscription?.hasEverSubscribed || false
        ]);

        console.log(`User ${userId} data saved to database with templateType: ${userData.templateType || 'html'}`);
        return true;
    } catch (error) {
        console.error(`Error saving user data for ${userId}:`, error);
        return false;
    }
}

async function getUserData(userId) {
    let userData = await loadUserData(userId);

    if (!userData) {
        // Create new user
        userData = {
            id: userId,
            balance: 0,
            joinDate: new Date(),
            totalDomains: 0,
            templateType: 'html',
            subscription: {
                active: false,
                startDate: null,
                endDate: null,
                domainsUsed: 0,
                dailyDomainsUsed: 0,
                lastDomainDate: null,
                hasEverSubscribed: false
            }
        };
        await saveUserData(userId, userData);
    }

    return userData;
}

async function updateUserBalance(userId, newBalance) {
    try {
        await pool.query(
            'UPDATE users SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newBalance, userId]
        );
        return true;
    } catch (error) {
        console.error(`Error updating balance for ${userId}:`, error);
        return false;
    }
}

// History operations
async function loadUserHistory(userId) {
    try {
        const result = await pool.query(
            'SELECT * FROM history WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );

        return result.rows.map(row => ({
            domain: row.domain,
            redirectUrl: row.redirect_url,
            date: row.created_at,
            urls: row.urls // JSONB field
        }));
    } catch (error) {
        console.error(`Error loading history for ${userId}:`, error);
        return [];
    }
}

async function saveUserHistory(userId, history) {
    try {
        // Delete existing history for this user
        await pool.query('DELETE FROM history WHERE user_id = $1', [userId]);

        // Insert all history records
        if (Array.isArray(history) && history.length > 0) {
            for (const item of history) {
                await pool.query(
                    'INSERT INTO history (user_id, domain, redirect_url, urls, created_at) VALUES ($1, $2, $3, $4, $5)',
                    [userId, item.domain, item.redirectUrl, JSON.stringify(item.urls), item.date]
                );
            }
        }

        console.log(`History for user ${userId} saved to database`);
        return true;
    } catch (error) {
        console.error(`Error saving history for ${userId}:`, error);
        return false;
    }
}

async function addUserHistory(userId, historyItem) {
    try {
        await pool.query(
            'INSERT INTO history (user_id, domain, redirect_url, urls, created_at) VALUES ($1, $2, $3, $4, $5)',
            [userId, historyItem.domain, historyItem.redirectUrl, JSON.stringify(historyItem.urls), historyItem.date || new Date()]
        );
        console.log(`History item added for user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Error adding history for ${userId}:`, error);
        return false;
    }
}

// Click tracking operations
async function trackClick(domain, ipAddress) {
    try {
        await pool.query(
            'INSERT INTO clicks (domain, ip_address) VALUES ($1, $2)',
            [domain, ipAddress]
        );
        return true;
    } catch (error) {
        console.error(`Error tracking click for ${domain}:`, error);
        return false;
    }
}

async function getClickStats(domain) {
    try {
        const result = await pool.query(
            'SELECT COUNT(*) as total_clicks FROM clicks WHERE domain = $1',
            [domain]
        );
        return parseInt(result.rows[0].total_clicks) || 0;
    } catch (error) {
        console.error(`Error getting click stats for ${domain}:`, error);
        return 0;
    }
}

// Topup operations
async function addTopup(userId, amount, transactionId = null) {
    try {
        await pool.query(
            'INSERT INTO topups (user_id, amount, transaction_id, status) VALUES ($1, $2, $3, $4)',
            [userId, amount, transactionId, 'completed']
        );
        return true;
    } catch (error) {
        console.error(`Error adding topup for ${userId}:`, error);
        return false;
    }
}

async function getTopupHistory(userId) {
    try {
        const result = await pool.query(
            'SELECT * FROM topups WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error(`Error loading topup history for ${userId}:`, error);
        return [];
    }
}

// Payment request operations
async function createPaymentRequest(userId, requestId, amount, proofUrl = null, transactionHash = null) {
    try {
        const result = await pool.query(
            'INSERT INTO payment_requests (user_id, request_id, amount, proof_url, transaction_hash, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [userId, requestId, amount, proofUrl, transactionHash, 'pending']
        );
        console.log(`Payment request created for user ${userId}: ${requestId}`);
        return result.rows[0];
    } catch (error) {
        console.error(`Error creating payment request for ${userId}:`, error);
        return null;
    }
}

async function getPaymentRequest(requestId) {
    try {
        const result = await pool.query(
            'SELECT * FROM payment_requests WHERE request_id = $1',
            [requestId]
        );
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
        console.error(`Error getting payment request ${requestId}:`, error);
        return null;
    }
}

async function updatePaymentRequestStatus(requestId, status, approvedAt = null, rejectedAt = null) {
    try {
        const result = await pool.query(
            'UPDATE payment_requests SET status = $1, approved_at = $2, rejected_at = $3 WHERE request_id = $4 RETURNING *',
            [status, approvedAt, rejectedAt, requestId]
        );
        console.log(`Payment request ${requestId} updated to ${status}`);
        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
        console.error(`Error updating payment request ${requestId}:`, error);
        return null;
    }
}

async function getPendingPaymentRequests(userId) {
    try {
        const result = await pool.query(
            'SELECT * FROM payment_requests WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC',
            [userId, 'pending']
        );
        return result.rows;
    } catch (error) {
        console.error(`Error getting pending payment requests for ${userId}:`, error);
        return [];
    }
}

async function getAllPaymentRequests(userId) {
    try {
        const result = await pool.query(
            'SELECT * FROM payment_requests WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error(`Error getting payment requests for ${userId}:`, error);
        return [];
    }
}

// Template reference images operations
async function setTemplateReferenceImage(templateType, fileId) {
    try {
        await pool.query(`
            INSERT INTO template_reference_images (template_type, file_id, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (template_type) DO UPDATE SET
                file_id = $2,
                updated_at = CURRENT_TIMESTAMP
        `, [templateType, fileId]);
        console.log(`Template reference image set for ${templateType}`);
        return true;
    } catch (error) {
        console.error(`Error setting template reference image for ${templateType}:`, error);
        return false;
    }
}

async function getTemplateReferenceImage(templateType) {
    try {
        const result = await pool.query(
            'SELECT file_id FROM template_reference_images WHERE template_type = $1',
            [templateType]
        );
        return result.rows.length > 0 ? result.rows[0].file_id : null;
    } catch (error) {
        console.error(`Error getting template reference image for ${templateType}:`, error);
        return null;
    }
}

async function getAllTemplateReferenceImages() {
    try {
        const result = await pool.query(
            'SELECT template_type, file_id FROM template_reference_images'
        );
        const images = {};
        result.rows.forEach(row => {
            images[row.template_type] = row.file_id;
        });
        return images;
    } catch (error) {
        console.error('Error getting all template reference images:', error);
        return {};
    }
}

// Test database connection
async function testConnection() {
    try {
        const result = await pool.query('SELECT NOW()');
        console.log('✅ Database connected successfully at', result.rows[0].now);
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
}

module.exports = {
    pool,
    loadUserData,
    saveUserData,
    getUserData,
    updateUserBalance,
    loadUserHistory,
    saveUserHistory,
    addUserHistory,
    trackClick,
    getClickStats,
    addTopup,
    getTopupHistory,
    createPaymentRequest,
    getPaymentRequest,
    updatePaymentRequestStatus,
    getPendingPaymentRequests,
    getAllPaymentRequests,
    setTemplateReferenceImage,
    getTemplateReferenceImage,
    getAllTemplateReferenceImages,
    testConnection
};
