'use strict';
const os = require('os');
/**
 * Starts up the discovery system,
 * querying for additional services and registering
 * itself into the system.
 * NOTE:
 *  if you do not want to store the token in the config files, we will search for it
 *  in process.env.DISCOVERY_KEY
 */
const SCONFIG_REGISTRY_QUERY = 'https://api.sconfig.io/discovery',
  SCONFIG_DISCOVERY = 'https://discovery.sconfig.io/dispatch';
const security = require('./security');
module.exports = function boot(thorin, opt, pluginObj) {
  const async = thorin.util.async,
    logger = thorin.logger(opt.logger);
  /*
   * Register the run() function to make sure that we're going to be registered.
   * */
  pluginObj.run = function(next) {
    let calls = [];
    // Check if we have the transport plugin and fetch its port.
    let tObj = thorin.transport('http'),
      transportConfig;
    if(tObj) {
      transportConfig = tObj.getConfig();
      if (!opt.service.port) {
        opt.service.port = transportConfig.port;
      }
      if(!opt.service.path) {
        opt.service.path = transportConfig.actionPath || '';
      }
    }
    opt.service.host = pluginObj.getIp(opt.service.host);
    /* Step one, check if we are integrated with sconfig. */
    calls.push((done) => {
      if (opt.token) return done();
      if (opt.gateway !== SCONFIG_DISCOVERY) return done();  // custom gateway.
      let sconfigKey = thorin.config.getSconfigKey();
      if (!sconfigKey) return done();
      // strip the private part out.
      sconfigKey = sconfigKey.split('.')[0];
      // try and fetch the discovery key from sconfig registry.
      logger.trace(`Fetching discovery token fron sconfig.io`);
      thorin
        .fetcher(SCONFIG_REGISTRY_QUERY, {
          timeout: 3000,
          authorization: sconfigKey,
          method: 'GET'
        })
        .dispatch('discovery.token')
        .then((r) => {
          opt.token = r.result.token;
          done();
        })
        .catch((e) => {
          logger.warn(`Could not fetch discovery token from sconfig: ${e.code}`);
          logger.trace(e);
          done(e);
        });
    });
    /* check that the token works. */
    calls.push((done) => {
      if(!opt.token && typeof process.env.DISCOVERY_KEY === 'string') {
        opt.token = process.env.DISCOVERY_KEY;
      }
      if (!opt.token) {
        logger.warn(`No discovery token found in configuration.`);
        return done(thorin.error('DISCOVERY.TOKEN', 'No valid discovery token available.'));
      }
      if(opt.token.indexOf('-') === -1) {
        opt.token = thorin.env + '-' + opt.token;
      }
      pluginObj.refresh(done);
    });

    async.series(calls, (e) => {
      if(e) return next(e);
      security.TOKEN = opt.token;
      pluginObj.start();
      next();
    });
  }

  /**
  * Manually start and stop the discovery system.
  * */
  let timer = null;
  pluginObj.start = function startDiscovery() {
    if(timer) {
      clearInterval(timer);
      timer = null;
    }
    let intervalSeconds = (opt.interval ? opt.interval : Math.abs(opt.service.ttl * 0.6) * 1000);
    intervalSeconds = Math.max(intervalSeconds, 2000); // min 2sec.
    timer = setInterval(() => {
      pluginObj.refresh();
    }, intervalSeconds);
  };
  pluginObj.stop = function StopDiscovery() {
    if(timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * Based on the given IP type, we will scan the server's IP addresses
   * and return the one that matches best.
   * VALUES:
   *   internal
   *   public
   *   {CIDR block}
   *   {IP address} (will simply return it)
   *   {domain} {will return the domain}
   * */
  pluginObj.getIp = function(type) {
    if (typeof type !== 'string' || !type) type = 'public';
    const ifaces = os.networkInterfaces();
    let names = Object.keys(ifaces);
    let isIp = thorin.sanitize('IP', type);
    if (isIp) {
      return isIp;
    }
    let isDomain = thorin.sanitize('domain', type, {
      underscore: true
    });
    if(isDomain) {
      return isDomain;
    }
    let isCidr = thorin.sanitize('IP_RANGE', type);
    for (let i = 0; i < names.length; i++) {
      let items = ifaces[names[i]];
      for (let j = 0; j < items.length; j++) {
        let item = items[j];
        if (item.family !== 'IPv4' || item.internal) continue;
        // Check if we have an internal type. If so, we return the first internal IP we find.
        if (type === 'internal') {
          let bVal = thorin.sanitize('IP', item.address, {
            private: true
          });
          if(bVal) {
            return item.address;
          }
        }
        // Check if we have public IPs. If so, we return the first public item.
        if (type === 'public') {
          let bVal = thorin.sanitize('IP', item.address, {
            public: true
          });
          if(bVal) {
            return item.address;
          }
        }
        // CHECK if we have a CIDR
        if(isCidr) {
          let isOk = thorin.sanitize('IP', item.address, {
            range: isCidr
          });
          if(isOk) {
            return item.address;
          }
        }
      }
    }
    logger.warn(`A valid IP address was not found.`);
    return null;
  };
};