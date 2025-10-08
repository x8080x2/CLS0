const { Client } = require('pg');
const fs = require('fs');

const DATABASE_URL = 'postgresql://neondb_owner:npg_gkbAPU7aWF3Y@ep-raspy-brook-a150lned-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

async function setupDatabase() {
    const client = new Client({
        connectionString: DATABASE_URL,
    });

    try {
        await client.connect();
        console.log('✅ Connected to Neon database');

        // Read and execute schema
        const schema = fs.readFileSync('schema.sql', 'utf8');
        await client.query(schema);
        console.log('✅ Database schema created successfully');

        // Verify tables
        const result = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name;
        `);
        
        console.log('\n📋 Created tables:');
        result.rows.forEach(row => console.log(`  - ${row.table_name}`));

    } catch (error) {
        console.error('❌ Error setting up database:', error.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

setupDatabase();
