const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function migrateData() {
    console.log('🚀 Starting data migration...');
    
    try {
        // Migrate user data
        const userFiles = fs.readdirSync('user_data').filter(f => f.endsWith('.json'));
        console.log(`\n📊 Migrating ${userFiles.length} users...`);
        
        for (const file of userFiles) {
            const userId = file.replace('.json', '');
            const userData = JSON.parse(fs.readFileSync(path.join('user_data', file), 'utf8'));
            
            await pool.query(`
                INSERT INTO users (
                    id, balance, join_date, total_domains, template_type,
                    subscription_active, subscription_start_date, 
                    subscription_end_date, subscription_domains_used,
                    daily_domains_used, last_domain_date, has_ever_subscribed
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
                    has_ever_subscribed = $12
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
            
            console.log(`  ✅ Migrated user ${userId}`);
        }
        
        // Migrate history data
        const historyFiles = fs.readdirSync('history_data').filter(f => f.endsWith('.json'));
        console.log(`\n📜 Migrating history for ${historyFiles.length} users...`);
        
        for (const file of historyFiles) {
            const userId = file.replace('.json', '');
            const history = JSON.parse(fs.readFileSync(path.join('history_data', file), 'utf8'));
            
            if (Array.isArray(history)) {
                for (const item of history) {
                    await pool.query(
                        'INSERT INTO history (user_id, domain, redirect_url, urls, created_at) VALUES ($1, $2, $3, $4, $5)',
                        [userId, item.domain, item.redirectUrl, JSON.stringify(item.urls), item.date || new Date()]
                    );
                }
                console.log(`  ✅ Migrated ${history.length} history items for user ${userId}`);
            }
        }
        
        // Check for topup data (currently empty except .gitkeep)
        const topupFiles = fs.readdirSync('topup_data').filter(f => f.endsWith('.json'));
        if (topupFiles.length > 0) {
            console.log(`\n💰 Migrating ${topupFiles.length} topup records...`);
            
            for (const file of topupFiles) {
                const userId = file.replace('.json', '');
                const topups = JSON.parse(fs.readFileSync(path.join('topup_data', file), 'utf8'));
                
                if (Array.isArray(topups)) {
                    for (const topup of topups) {
                        await pool.query(
                            'INSERT INTO topups (user_id, amount, transaction_id, status, created_at) VALUES ($1, $2, $3, $4, $5)',
                            [userId, topup.amount, topup.transactionId, topup.status || 'completed', topup.date || new Date()]
                        );
                    }
                    console.log(`  ✅ Migrated ${topups.length} topups for user ${userId}`);
                }
            }
        }
        
        // Summary
        const userCount = await pool.query('SELECT COUNT(*) FROM users');
        const historyCount = await pool.query('SELECT COUNT(*) FROM history');
        const topupCount = await pool.query('SELECT COUNT(*) FROM topups');
        
        console.log('\n✨ Migration completed successfully!');
        console.log(`   👥 Users: ${userCount.rows[0].count}`);
        console.log(`   📜 History: ${historyCount.rows[0].count}`);
        console.log(`   💰 Topups: ${topupCount.rows[0].count}`);
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrateData();
