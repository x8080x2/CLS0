
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// JWT secret - use environment variable in production
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex');

// Token expiry times
const ACCESS_TOKEN_EXPIRY = '15m'; // 15 minutes
const REFRESH_TOKEN_EXPIRY = '7d'; // 7 days

// Store for active refresh tokens (use Redis in production)
const refreshTokenStore = new Map();

// Store for CSRF tokens
const csrfTokenStore = new Map();

// Generate access token
function generateAccessToken(userId, isAdmin = false) {
  return jwt.sign(
    { 
      userId, 
      isAdmin,
      type: 'access'
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

// Generate refresh token
function generateRefreshToken(userId) {
  const token = jwt.sign(
    { 
      userId,
      type: 'refresh'
    },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
  
  // Store refresh token
  if (!refreshTokenStore.has(userId)) {
    refreshTokenStore.set(userId, new Set());
  }
  refreshTokenStore.get(userId).add(token);
  
  return token;
}

// Generate CSRF token
function generateCsrfToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokenStore.set(userId, token);
  
  // Auto-expire CSRF token after 1 hour
  setTimeout(() => {
    if (csrfTokenStore.get(userId) === token) {
      csrfTokenStore.delete(userId);
    }
  }, 3600000);
  
  return token;
}

// Verify CSRF token
function verifyCsrfToken(userId, token) {
  const storedToken = csrfTokenStore.get(userId);
  return storedToken && storedToken === token;
}

// Verify access token
function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'access') {
      return null;
    }
    return decoded;
  } catch (error) {
    return null;
  }
}

// Verify refresh token
function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') {
      return null;
    }
    
    // Check if token is still in store
    const userTokens = refreshTokenStore.get(decoded.userId);
    if (!userTokens || !userTokens.has(token)) {
      return null;
    }
    
    return decoded;
  } catch (error) {
    return null;
  }
}

// Revoke refresh token
function revokeRefreshToken(userId, token) {
  const userTokens = refreshTokenStore.get(userId);
  if (userTokens) {
    userTokens.delete(token);
    if (userTokens.size === 0) {
      refreshTokenStore.delete(userId);
    }
  }
}

// Revoke all refresh tokens for user
function revokeAllRefreshTokens(userId) {
  refreshTokenStore.delete(userId);
  csrfTokenStore.delete(userId);
}

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyAccessToken(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.user = {
    userId: decoded.userId,
    isAdmin: decoded.isAdmin
  };
  
  next();
}

// Admin authorization middleware
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// CSRF protection middleware
function csrfProtection(req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const csrfToken = req.headers['x-csrf-token'];
    
    if (!csrfToken || !verifyCsrfToken(req.user.userId, csrfToken)) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  
  next();
}

// Rate limiting store
const rateLimitStore = new Map();

// Rate limiting middleware
function rateLimit(options = {}) {
  const windowMs = options.windowMs || 60000; // 1 minute
  const maxRequests = options.maxRequests || 10;
  
  return (req, res, next) => {
    const identifier = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimitStore.has(identifier)) {
      rateLimitStore.set(identifier, []);
    }
    
    const requests = rateLimitStore.get(identifier);
    
    // Remove old requests outside window
    const validRequests = requests.filter(time => now - time < windowMs);
    
    if (validRequests.length >= maxRequests) {
      return res.status(429).json({ 
        error: 'Too many requests',
        retryAfter: Math.ceil((validRequests[0] + windowMs - now) / 1000)
      });
    }
    
    validRequests.push(now);
    rateLimitStore.set(identifier, validRequests);
    
    next();
  };
}

// Cleanup old rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [identifier, requests] of rateLimitStore.entries()) {
    const validRequests = requests.filter(time => now - time < 60000);
    if (validRequests.length === 0) {
      rateLimitStore.delete(identifier);
    } else {
      rateLimitStore.set(identifier, validRequests);
    }
  }
}, 60000);

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateCsrfToken,
  verifyCsrfToken,
  verifyAccessToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  authenticateToken,
  requireAdmin,
  csrfProtection,
  rateLimit
};
