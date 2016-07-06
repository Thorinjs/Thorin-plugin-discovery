'use strict';
/**
 * This registry will handle the synchronisation of services,
 * announces and authorization tokens.
 */
const CONNECT_ERRORS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOENT',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EADDRNOTAVAIL',
  'ESERVICEUNAVAILABLE'
];

module.exports = function(thorin, opt, pluginObj) {
  const logger = thorin.logger(opt.logger),
    security = require('./security'),
    fetch = thorin.util.fetch;
  let REGISTRY = {},
    fetcherObj,
    serviceKey = null,
    currentSid = null;

  /* Handle a backup mechanism in case the registry is down */
  if(opt.cache) {
    let oldRegistry = thorin.persist('discovery_registry');
    if(typeof oldRegistry === 'object' && oldRegistry) {
      REGISTRY = oldRegistry;
    }
  }

  /* Marks a node as unhealthy. */
  function unhealthyNode(item) {
    item.healty = false;
  }

  /**
  * Returns the current state of the registry.
  * */
  pluginObj.getRegistry = () => REGISTRY;

  /**
   * Manually elect a service node to peform a FETCH.
   * When we have multiple nodes of the same type, we will split the load between them
   *
   * */
  pluginObj.elect = function ElectNode(serviceName) {
    if (typeof serviceName !== 'string' || !serviceName) return null;
    if (typeof REGISTRY[serviceName] === 'undefined') return null;
    let tmp = [];
    for (let i = 0; i < REGISTRY[serviceName].length; i++) {
      let item = REGISTRY[serviceName][i];
      if (!item.healthy) continue;
      tmp.push(item);
    }
    if (tmp.length === 0) return null;
    if (tmp.length === 1) return tmp[0];
    let idx = Math.floor(Math.random() * tmp.length);
    return tmp[idx];
  }

  /**
   * Manually refresh the registry.
   * */
  pluginObj.refresh = function RefreshRegistry(done) {
    if (!fetcherObj) {
      fetcherObj = thorin.fetcher(opt.gateway, {
        authorization: opt.token
      });
    }
    // CHECK if we are registering as an incoming node or just as a node that can perform calls.
    let isIncoming = (opt.service && opt.service.port && opt.service.host && opt.service.type),
      actionName = (isIncoming ? 'registry.announce' : 'registry.get'),
      actionPayload = (isIncoming ? opt.service : {});
    fetcherObj
      .dispatch(actionName, actionPayload)
      .then((r) => {
        if (r.meta) {
          serviceKey = r.meta.service_key;
          currentSid = r.meta.sid;
        }
        // update the internal registry.
        let NEW_REGISTRY = {},
          count = 0;
        if (r.result instanceof Array) {
          for (let i = 0, len = r.result.length; i < len; i++) {
            let item = r.result[i];
            if (typeof NEW_REGISTRY[item.type] === 'undefined') NEW_REGISTRY[item.type] = [];
            NEW_REGISTRY[item.type].push(item);
            delete item.type;
            item.healthy = true;
            count++;
          }
        }
        REGISTRY = NEW_REGISTRY;
        if(opt.cache) {
          // persist the current registry
          thorin.persist('discovery_registry', REGISTRY);
        }
        if (typeof done === 'function') {
          let msg = `Joined the registry cluster`;
          if(isIncoming) {
            msg += ' as receiver';
          } else {
            msg += ' as sender';
          }
          msg += ` [nodes: ${count}]`;
          logger.trace(msg);
          done();
        }
      })
      .catch((e) => {
        logger.warn(`Could not refresh registry: ${e.code}`);
        if (typeof done === 'function') {
          logger.warn(e);
          done(e);
        }
      });
  }

  /**
  * Returns the assigned registry service authorization key.
  * */
  pluginObj.getServiceKey = () => serviceKey;


  /**
   * Performs a request to the given service, using the action/payload specified.
   * Arguments:
   * serviceName - the service that we want to proxy the request.
   * actionName - the action we want to send to the server.
   * payload={} - the payload we want to send. This must be a key-value object.
   * */
  pluginObj.dispatch = function DispatchAction(serviceName, actionName, payload, _options) {
    if (typeof serviceName !== 'string' || !serviceName) {
      return Promise.reject(thorin.error('REGISTRY.DISPATCH', 'A valid service name is required.'));
    }
    if (typeof actionName !== 'string' || !actionName) {
      return Promise.reject(thorin.error('REGISTRY.DISPATCH', 'A valid action name is required.'));
    }
    if (typeof payload !== 'object' || !payload) payload = {};
    let serviceNode = pluginObj.elect(serviceName);
    if (!serviceNode) {
      return Promise.reject(thorin.error('REGISTRY.DISPATCH', 'Service node is offline.'));
    }
    return new Promise((resolve, reject) => {
      let url = serviceNode.proto + '://' + serviceNode.host;
      if (serviceNode.port !== 80 && serviceNode.port !== 443) {
        url += ':' + serviceNode.port;
      }
      if (serviceNode.path) url += serviceNode.path;
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'thorin-discovery',
        'Accept': 'application/json'
      }
      let bodyPayload = {
        type: actionName,
        payload: payload
      }
      if (serviceKey) {
        headers['Authorization'] = 'Bearer ' + security.sign(bodyPayload, opt.service);
      }
      if(_options instanceof thorin.Intent) {
        _options = {
          headers: {
            'X-Forwarded-For': _options.client('ip')
          }
        };
      }
      let fetchOpt = thorin.util.extend({
        method: 'POST',
        follow: 1,
        timeout: opt.timeout,
        headers: headers
      }, _options);
      try {
        fetchOpt.body = JSON.stringify(bodyPayload);
      } catch (e) {
        return reject(thorin.error('REGISTRY.DISPATCH', 'Could not serialize payload.', e));
      }
      let statusCode;
      fetch(url, fetchOpt)
        .then((res) => {
          statusCode = res.status;
          if(statusCode === 502 || statusCode === 503 || statusCode === 504) {
            let e = new Error(res.statusText);
            e.status = statusCode;
            e.code = 'ESERVICEUNAVAILABLE';
            throw e;
          }
          return res.json();
        })
        .then((result) => {
          if(typeof result.error === 'object' && result.error) {
            let err = thorin.error(result.error.code || 'REGISTRY.DISPATCH', result.error.message || 'Service node encountered an error', result.error.status || statusCode);
            if(result.error.ns) err.ns = result.error.ns;
            throw err;
          }
          resolve(result);
        })
        .catch((e) => {
          if(e.name === 'FetchError' || CONNECT_ERRORS.indexOf(e.code) !== -1) {
            unhealthyNode(serviceNode);
            logger.warn(`Service [${serviceName} - ${url}] is unhealthy: ${e.code || e.message}`, e);
            return reject(thorin.error('REGISTRY.DISPATCH', 'Could not contact service node.', 500));
          }
          if(e instanceof SyntaxError) {
            return reject(thorin.error('REGISTRY.DISPATCH', 'Could not parse service response data.'));
          }
          if(e.name && e.name.indexOf('Thorin') === 0) {
            return reject(e);
          }
          logger.warn(`Service [${serviceName} - ${url}] returned with an error: ${statusCode}: ${e.message}`);
          return reject(thorin.error('REGISTRY.DISPATCH', 'Coult not contact service', e, 500));
        });
    });
  };
}