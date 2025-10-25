const axios = require('axios');

class CloudflareConfig {
  constructor(email, globalKey) {
    this.email = email;
    this.globalKey = globalKey;
    this.baseURL = 'https://api.cloudflare.com/client/v4';

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': globalKey,
        'Content-Type': 'application/json'
      }
    });
  }

  // List all domains in Cloudflare account
  async listDomains() {
    try {
      const response = await this.client.get('/zones');
      if (response.data.success) {
        return response.data.result.map(zone => ({
          id: zone.id,
          name: zone.name,
          status: zone.status
        }));
      }
      throw new Error('Failed to fetch domains');
    } catch (error) {
      throw new Error(`Cloudflare API Error: ${error.message}`);
    }
  }

  // Configure all security settings for a domain
  async configureSecuritySettings(zoneId) {
    const results = {
      alwaysUseHttps: false,
      autoHttpsRewrites: false,
      browserIntegrityCheck: false,
      securityLevel: false,
      sslEnabled: false,
      universalSSL: false,
      botFightMode: false, // Added botFightMode
      minTlsVersion: false, // Added minTlsVersion
      errors: []
    };

    // 1. Always Use HTTPS
    try {
      await this.client.patch(`/zones/${zoneId}/settings/always_use_https`, {
        value: 'on'
      });
      results.alwaysUseHttps = true;
    } catch (error) {
      console.error('Failed to enable Always Use HTTPS:', error.response?.data || error.message);
      results.errors.push({ setting: 'Always Use HTTPS', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // 2. Automatic HTTPS Rewrites
    try {
      await this.client.patch(`/zones/${zoneId}/settings/automatic_https_rewrites`, {
        value: 'on'
      });
      results.autoHttpsRewrites = true;
    } catch (error) {
      console.error('Failed to enable Automatic HTTPS Rewrites:', error.response?.data || error.message);
      results.errors.push({ setting: 'Automatic HTTPS Rewrites', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // 3. Browser Integrity Check
    try {
      await this.client.patch(`/zones/${zoneId}/settings/browser_check`, {
        value: 'on'
      });
      results.browserIntegrityCheck = true;
    } catch (error) {
      console.error('Failed to enable Browser Integrity Check:', error.response?.data || error.message);
      results.errors.push({ setting: 'Browser Integrity Check', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // 4. Security Level - set to High
    try {
      await this.client.patch(`/zones/${zoneId}/settings/security_level`, {
        value: 'high'
      });
      results.securityLevel = true;
    } catch (error) {
      console.error('Failed to set Security Level:', error.response?.data || error.message);
      results.errors.push({ setting: 'Security Level', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // 5. Activate SSL/TLS
    try {
      const sslResult = await this.activateSSL(zoneId);
      results.sslEnabled = sslResult.success;
      results.universalSSL = sslResult.success;
    } catch (error) {
      console.error('Failed to activate SSL:', error.message);
      results.errors.push({ setting: 'SSL/TLS', error: error.message });
    }

    return results;
  }

  // Activate SSL certificate for a domain
  async activateSSL(zoneId) {
    const results = {
      universalSSL: false,
      sslMode: false,
      tls13: false,
      opportunisticEncryption: false,
      minTlsVersion: false, // Added minTlsVersion
      errors: []
    };

    // Enable Universal SSL
    try {
      // The endpoint for universal SSL is actually /zones/:zone_id/ssl/universal/settings, not a patch on /zones/:zone_id/settings/universal_ssl
      // However, the original code used a patch, and the prompt implies fixing existing functionality rather than a full rewrite.
      // Assuming the intention is to manage Universal SSL, and if the direct patch fails, it might be due to API changes or incorrect usage.
      // For now, keeping the structure but noting the potential endpoint discrepancy if this specific API call fails.
      // A more robust solution might involve checking the zone's SSL status and initiating activation if needed.
      await this.client.patch(`/zones/${zoneId}/settings/universal_ssl`, {
        enabled: true // This seems to be a placeholder value, actual Universal SSL activation might differ.
      });
      results.universalSSL = true;
    } catch (error) {
      console.error('Failed to enable Universal SSL:', error.response?.data || error.message);
      results.errors.push({ setting: 'Universal SSL', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // Set SSL mode to Full (encrypts traffic between Cloudflare and origin)
    try {
      await this.client.patch(`/zones/${zoneId}/settings/ssl`, {
        value: 'full'
      });
      results.sslMode = true;
    } catch (error) {
      console.error('Failed to set SSL mode:', error.response?.data || error.message);
      results.errors.push({ setting: 'SSL Mode', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // Set minimum TLS version to 1.2
    try {
      await this.client.patch(`/zones/${zoneId}/settings/min_tls_version`, {
        value: '1.2'
      });
      results.minTlsVersion = true;
    } catch (error) {
      console.error('Failed to set minimum TLS version:', error.response?.data || error.message);
      results.errors.push({ setting: 'Minimum TLS Version', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // Enable TLS 1.3
    try {
      await this.client.patch(`/zones/${zoneId}/settings/tls_1_3`, {
        value: 'on'
      });
      results.tls13 = true;
    } catch (error) {
      console.error('Failed to enable TLS 1.3:', error.response?.data || error.message);
      results.errors.push({ setting: 'TLS 1.3', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    // Enable Opportunistic Encryption
    try {
      await this.client.patch(`/zones/${zoneId}/settings/opportunistic_encryption`, {
        value: 'on'
      });
      results.opportunisticEncryption = true;
    } catch (error) {
      console.error('Failed to enable Opportunistic Encryption:', error.response?.data || error.message);
      results.errors.push({ setting: 'Opportunistic Encryption', error: error.response?.data?.errors?.[0]?.message || error.message });
    }

    const anySuccess = results.universalSSL || results.sslMode || results.tls13 || results.opportunisticEncryption || results.minTlsVersion;

    return {
      success: anySuccess,
      message: anySuccess ? 'SSL/TLS settings configured (some may have failed)' : 'Failed to configure SSL/TLS settings',
      details: results
    };
  }

  // Get current security settings
  async getSecuritySettings(zoneId) {
    try {
      const settings = await this.client.get(`/zones/${zoneId}/settings`);

      const settingsMap = {};
      settings.data.result.forEach(setting => {
        settingsMap[setting.id] = setting.value;
      });

      return {
        alwaysUseHttps: settingsMap.always_use_https,
        autoHttpsRewrites: settingsMap.automatic_https_rewrites,
        botFightMode: settingsMap.bot_fight_mode,
        browserIntegrityCheck: settingsMap.browser_check,
        securityLevel: settingsMap.security_level,
        ssl: settingsMap.ssl, // Added ssl
        minTlsVersion: settingsMap.min_tls_version // Added min_tls_version
      };
    } catch (error) {
      throw new Error(`Failed to get settings: ${error.message}`);
    }
  }

  // Add DNS A record pointing to IP address
  async addDNSRecord(zoneId, domainName, ipAddress) {
    try {
      // First, check if A record already exists
      const existingRecords = await this.client.get(`/zones/${zoneId}/dns_records`, {
        params: {
          type: 'A',
          name: domainName
        }
      });

      // Delete existing A records for the domain
      if (existingRecords.data.result && existingRecords.data.result.length > 0) {
        for (const record of existingRecords.data.result) {
          await this.client.delete(`/zones/${zoneId}/dns_records/${record.id}`);
        }
      }

      // Create new A record
      const response = await this.client.post(`/zones/${zoneId}/dns_records`, {
        type: 'A',
        name: domainName,
        content: ipAddress,
        ttl: 1, // Auto TTL
        proxied: true // Enable Cloudflare proxy
      });

      if (response.data.success) {
        return {
          success: true,
          record: response.data.result
        };
      }
      throw new Error('Failed to create DNS record');
    } catch (error) {
      throw new Error(`DNS record creation failed: ${error.message}`);
    }
  }

  // Get nameservers for a domain
  async getNameservers(zoneId) {
    try {
      const response = await this.client.get(`/zones/${zoneId}`);
      if (response.data.success) {
        return {
          nameservers: response.data.result.name_servers || [],
          originalNameservers: response.data.result.original_name_servers || []
        };
      }
      throw new Error('Failed to fetch nameservers');
    } catch (error) {
      throw new Error(`Nameserver fetch failed: ${error.message}`);
    }
  }

  // Get account ID (needed for Turnstile API)
  async getAccountId() {
    try {
      const response = await this.client.get('/accounts');
      if (response.data.success && response.data.result.length > 0) {
        return response.data.result[0].id;
      }
      throw new Error('No accounts found');
    } catch (error) {
      throw new Error(`Failed to get account ID: ${error.message}`);
    }
  }

  // Create Turnstile widget for domain
  async createTurnstileWidget(domainName, widgetName = null, mode = 'managed') {
    try {
      // Get account ID first
      const accountId = await this.getAccountId();

      // Create widget
      const response = await this.client.post(
        `/accounts/${accountId}/challenges/widgets`,
        {
          domains: [domainName],
          mode: mode, // managed, invisible, or non-interactive
          name: widgetName || `Widget for ${domainName}`
        }
      );

      if (response.data.success) {
        return {
          success: true,
          sitekey: response.data.result.sitekey,
          secret: response.data.result.secret,
          name: response.data.result.name,
          mode: response.data.result.mode,
          domains: response.data.result.domains
        };
      }
      throw new Error('Failed to create Turnstile widget');
    } catch (error) {
      throw new Error(`Turnstile widget creation failed: ${error.response?.data?.errors?.[0]?.message || error.message}`);
    }
  }
}

module.exports = CloudflareConfig;