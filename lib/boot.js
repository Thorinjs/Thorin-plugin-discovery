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
    if(!opt.token && typeof process.env.DISCOVERY_KEY === 'string') {
      opt.token = process.env.DISCOVERY_KEY;
    }
    /* Step one, check if we are integrated with sconfig. */
    calls.push((done) => {
      if (opt.token) return done();
      if (opt.gateway !== SCONFIG_DISCOVERY) return done();  // custom gateway.
      let sconfigKey = thorin.config.getSconfigKey();
      if (!sconfigKey) return done();
      // strip the private part out.
      sconfigKey = sconfigKey.split('.')[0];
      // try and fetch the discovery key from sconfig registry.
      logger.trace(`Fetching discovery token from sconfig.io`);
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
  };

  /**
   * Based on the given IP type, we will scan the server's IP addresses
   * and return the one that matches best.
   * VALUES:
   *   internal
   *   public
   *   {CIDR block}
   *   {IP address} (will simply return it)
   *   {domain} {will return the domain}
   *    internal -> 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
        public -> fetch the publicly accessible IP address. We will scan all network interfaces.
        {CIDR block} -> match our interfaces against the CIDR and place the first one.
        {any other IP} -> we will use this as the IP address of the node
        {any domain} -> we will use the domain as the host.
   * */
  pluginObj.getIp = thorin.getIp.bind(thorin);
};