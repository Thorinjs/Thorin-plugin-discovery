'use strict';
/**
 * Created by Adrian on 19-Mar-16.
 */
const initAction = require('./lib/discoveryAction'),
  initRegistry = require('./lib/registry'),
  initMiddleware = require('./lib/middleware/index'),
  initBoot = require('./lib/boot');
module.exports = function (thorin, opt, pluginName) {
  opt = thorin.util.extend({
    logger: pluginName || 'discovery',
    gateway: 'https://discovery.sconfig.io/dispatch', // the default thorin discovery gateway
    dispatchPath: '/dispatch',              // the default dispatch path to apply for all services.
    token: null,                            // this is the discovery token.
    debug: false,
    interval: null,                         // the interval in milliseconds we query the registry. This is automatically calculated based on the service's ttl
    cache: true,                            // We will try to cache the registry service information with thorin.persist, in case the discovery server is down.
    retry: 1,                               // the number of retries we will perform per service call.
    delay: 0,                               // the number of milliseconds to delay the initial registration. Default disabled.
    timeout: 3000,                          // the default timeout between service calls
    registry: null,                         // We can manually set a map of {serviceName:url} to use, withouth polling an external discovery system
    refresh: true,                          // Setting this to false will not refresh the registry.
    service: {
      type: thorin.app,                     // this is the service type. This is the "service name" within the registry.
      name: thorin.id,                      // this is an optional unique service name.
      proto: 'http',                        // the default protocol to use.
      version: null,                          // The numeric version of the current application version. This is to roll out older version versions of the app, so that we have zero-downtime upgrades
      // IF this variable is not set, we look into process.env.APP_VERSION and if it is a number, we use it.
      ttl: 60,                              // this is the default time-to-live for the registry. We will refresh the registry within approx 2/3 of the ttl.
      timeout: null,                        // number of ms to timeout when other nodes are calling this. Overrides the default timeout
      tags: [],                              // additional tags that can be saved per-service.
      host: 'internal',                       // Specifies the IP or host on which the current node is reachable. Values are:
      // internal -> 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
      // public -> fetch the publicly accessible IP address. We will scan all network interfaces.
      // {CIDR block} -> match our interfaces against the CIDR and place the first one.
      // {any other IP} -> we will use this as the IP address of the node
      // {any domain} -> we will use the domain as the host.
      port: null,                            // This is the service port that will be used for requests. This will default to the http transport's port (if available)
      path: null                            // This is the default dispatch path other nodes use to communicate with us. This will default to the http transport's dispatch path (if available)
    }
  }, opt);
  if (typeof opt.service === 'object' && opt.service) {
    if (opt.service.version == null && typeof process.env.APP_VERSION !== 'undefined') {
      let ver = process.env.APP_VERSION;
      if(typeof ver === 'string') ver = parseInt(ver, 10);
      if(typeof ver === 'number' && ver > 0) {
        opt.service.version = ver;
      }
    }
  }

  const logger = thorin.logger(opt.logger),
    pluginObj = {};

  initRegistry(thorin, opt, pluginObj);
  initMiddleware(thorin, opt, pluginObj);
  initBoot(thorin, opt, pluginObj);
  initAction(thorin, opt, pluginObj);

  return pluginObj;
};
module.exports.publicName = 'discovery';
