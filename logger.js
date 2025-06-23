
const pino = require('pino');

// Statistics tracking
const stats = {
  startTime: Date.now(),
  requests: {
    total: 0,
    success: 0,
    errors: 0,
    domains: new Set(),
    users: new Set()
  },
  whm: {
    requests: 0,
    errors: 0,
    avgResponseTime: 0,
    responseTimes: []
  },
  sessions: {
    created: 0,
    active: 0,
    cleaned: 0
  }
};

// Enhanced Logger
const baseLog = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  } : undefined
});

// Logger factory
const createLogger = (component) => baseLog.child({ component });

// Statistics functions
const incrementStat = (path, value = 1) => {
  const keys = path.split('.');
  let current = stats;
  
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {};
    current = current[keys[i]];
  }
  
  const finalKey = keys[keys.length - 1];
  if (typeof current[finalKey] === 'number') {
    current[finalKey] += value;
  } else {
    current[finalKey] = value;
  }
};

const addToSet = (path, value) => {
  const keys = path.split('.');
  let current = stats;
  
  for (let i = 0; i < keys.length - 1; i++) {
    current = current[keys[i]];
  }
  
  const finalKey = keys[keys.length - 1];
  if (current[finalKey] instanceof Set) {
    current[finalKey].add(value);
  }
};

const addResponseTime = (time) => {
  stats.whm.responseTimes.push(time);
  if (stats.whm.responseTimes.length > 100) {
    stats.whm.responseTimes.shift(); // Keep only last 100
  }
  
  stats.whm.avgResponseTime = Math.round(
    stats.whm.responseTimes.reduce((a, b) => a + b, 0) / stats.whm.responseTimes.length
  );
};

const getStats = () => {
  const uptime = Date.now() - stats.startTime;
  return {
    ...stats,
    uptime: {
      ms: uptime,
      seconds: Math.round(uptime / 1000),
      minutes: Math.round(uptime / 60000),
      hours: Math.round(uptime / 3600000)
    },
    requests: {
      ...stats.requests,
      domains: stats.requests.domains.size,
      users: stats.requests.users.size,
      successRate: stats.requests.total > 0 ? 
        Math.round((stats.requests.success / stats.requests.total) * 100) : 0
    }
  };
};

// Performance monitoring
const performanceMonitor = {
  start: (operation) => {
    return {
      operation,
      startTime: Date.now(),
      end: function(additionalData = {}) {
        const duration = Date.now() - this.startTime;
        createLogger('performance').info({
          operation: this.operation,
          duration: `${duration}ms`,
          ...additionalData
        }, `Operation ${this.operation} completed`);
        return duration;
      }
    };
  }
};

module.exports = {
  createLogger,
  stats: {
    increment: incrementStat,
    addToSet,
    addResponseTime,
    get: getStats
  },
  performanceMonitor
};
