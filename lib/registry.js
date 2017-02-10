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

module.exports = function (thorin, opt, pluginObj) {
  const logger = thorin.logger(opt.logger),
    security = require('./security'),
    fetch = thorin.util.fetch;
  let REGISTRY = {},
    fetcherObj,
    serviceKey = null,
    currentSid = null;

  /* Handle a backup mechanism in case the registry is down */
  if (opt.cache) {
    let oldRegistry = thorin.persist('discovery_registry');
    if (typeof oldRegistry === 'object' && oldRegistry) {
      REGISTRY = oldRegistry;
    }
  }

  /* Marks a node as unhealthy. */
  function unhealthyNode(item) {
    item.healthy = false;
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
    let tmp = [],
      serviceItems = REGISTRY[serviceName];
    if (serviceItems.length === 0) return null;
    for (let i = 0, len = serviceItems.length; i < len; i++) {
      let item = serviceItems[i];
      if (!item.healthy) continue;
      tmp.push(item);
    }
    if (tmp.length === 0) { // if we have no healthy item, we return a random from the serviceItems
      let tidx = Math.floor(Math.random() * serviceItems.length);
      return serviceItems[tidx];
    }
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
            let item = r.result[i],
              canAdd = true;
            if (item.proto !== 'http' && item.proto !== 'https') continue;
            if (typeof NEW_REGISTRY[item.type] === 'undefined') {
              NEW_REGISTRY[item.type] = [];
            } else {
              for (let j = 0; j < NEW_REGISTRY[item.type].length; j++) {
                if (NEW_REGISTRY[item.type][j].sid === item.sid) {
                  canAdd = false;
                }
              }
            }
            if (canAdd) {
              NEW_REGISTRY[item.type].push(item);
            }
            delete item.type;
            item.healthy = true;
            count++;
          }
        }
        REGISTRY = NEW_REGISTRY;
        if (opt.cache) {
          // persist the current registry
          thorin.persist('discovery_registry', REGISTRY);
        }
        if (typeof done === 'function') {
          let msg = `Joined the registry cluster`;
          if (isIncoming) {
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

  /* Internal function that will dispatch the action to a given service node. */
  function doDispatch(serviceNode, fetchOpt, done) {
    let url = serviceNode.proto + '://' + serviceNode.host;
    if (serviceNode.port !== 80 && serviceNode.port !== 443) {
      url += ':' + serviceNode.port;
    }
    if (serviceNode.path) url += serviceNode.path;
    let statusCode, headers;
    fetch(url, fetchOpt)
      .then((res) => {
        statusCode = res.status;
        if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
          let e = new Error(res.statusText);
          e.status = statusCode;
          e.code = 'ESERVICEUNAVAILABLE';
          throw e;
        }
        headers = res.headers;
        return res.json();
      })
      .then((result) => {
        if (typeof result.error === 'object' && result.error) {
          let err = thorin.error(result.error.code || 'REGISTRY.DISPATCH', result.error.message || 'Service node encountered an error', result.error.status || statusCode);
          if (result.error.ns) err.ns = result.error.ns;
          if (result.error.data) err.data = result.error.data;
          result.serviceNode = url;
          throw err;
        }
        done(null, result, headers);
      })
      .catch((e) => {
        if (typeof fetchOpt.request === 'function' && e.code === 'ECONNRESET') {  // this was aborted possibly.
          return done(thorin.error('ABORTED', 'Request aborted'));
        }
        if (e.name === 'FetchError' || CONNECT_ERRORS.indexOf(e.code) !== -1) {
          if (serviceNode.healthy) {
            unhealthyNode(serviceNode);
            logger.warn(`Service [${serviceNode.name} - ${url}] is unhealthy: ${e.code || e.message}`, e);
          }
          let err = thorin.error('REGISTRY.DISPATCH', 'Could not contact service node.', 500);
          err.offline = true;
          return done(err);
        }
        if (e instanceof SyntaxError) {
          return done(thorin.error('REGISTRY.DISPATCH', 'Could not parse service response data.', 500));
        }
        if (e.name && e.name.indexOf('Thorin') === 0) {
          return done(e);
        }
        logger.warn(`Service [${serviceNode.name} - ${url}] returned with an error: ${statusCode}: ${e.message}`);
        return done(thorin.error('REGISTRY.DISPATCH', 'Could not contact service', e, statusCode));
      });
  }

  /* Internal function that encapsulates retry functionality. It elects a new node every time. */
  function doRetryDispatch(serviceName, fetchOpt, current, max, done) {
    let serviceNode = pluginObj.elect(serviceName);
    doDispatch(serviceNode, fetchOpt, (err, res) => {
      if (!err) return done(null, res);
      if (err.code === 'ABORTED') return done(err);  // aborted
      if (err.offline !== true) return done(err);  // an application-level error.
      current++;
      if (current >= max) {  // stop retry
        return done(err);
      }
      doRetryDispatch(serviceName, fetchOpt, current, max, done);
    });
  }

  /**
   * Performs a manual dispatch to a given serivceName, with custom HTTP Headers and options.
   * This is useful for proxy requests.
   * */
  pluginObj.rawDispatch = function ProxyDispatch(serviceName, body, fetchOpt) {
    if (typeof serviceName !== 'string' || !serviceName) {
      return Promise.reject(thorin.error('REGISTRY.DISPATCH', 'A valid service name is required.'));
    }
    if (typeof body !== 'object' || !body) body = {};
    if (typeof fetchOpt !== 'object' || !fetchOpt) fetchOpt = {};
    let serviceNode = pluginObj.elect(serviceName);
    if (!serviceNode) {
      logger.trace(`Service node is offline for: ${serviceName}, raw dispatch`);
      return Promise.reject(thorin.error('REGISTRY.DISPATCH', 'Service node is offline.', {
        node: serviceName
      }, 500));
    }
    return new Promise((resolve, reject) => {
      if (typeof fetchOpt.method !== 'string') fetchOpt.method = 'POST';
      fetchOpt.follow = 1;
      if (typeof fetchOpt.timeout !== 'number') fetchOpt.timeout = serviceNode.timeout || opt.timeout;
      fetchOpt.body = JSON.stringify(body);
      doDispatch(serviceNode, fetchOpt, (err, res, headers) => {
        if (err) return reject(err);
        resolve({
          result: res,
          headers
        });
      });
    });
  };

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
      logger.trace(`Service node is offline for: ${serviceName}, action: ${actionName}`);
      return Promise.reject(thorin.error('REGISTRY.DISPATCH', 'Service node is offline.', {
        node: serviceName
      }, 500));
    }

    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'thorin-discovery',
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      };
      let filter, meta;
      if (typeof payload.filter === 'object' && payload.filter) {
        filter = payload.filter;
        delete payload.filter;
      }
      if (typeof payload.meta === 'object' && payload.meta) {
        meta = payload.meta;
        delete payload.meta;
      }
      if (typeof payload.payload === 'object' && payload.payload) {
        payload = payload.payload;
      }
      let bodyPayload = {
        type: actionName,
        payload: payload
      };
      if (filter) bodyPayload.filter = filter;
      if (meta) bodyPayload.meta = meta;
      if (serviceKey) {
        headers['Authorization'] = 'Bearer ' + security.sign(bodyPayload, opt.service);
      }

      let fetchOpt = thorin.util.extend({
        method: 'POST',
        follow: 1,
        timeout: opt.timeout || serviceNode.timeout,
        headers: headers
      }, _options);
      try {
        fetchOpt.body = JSON.stringify(bodyPayload);
      } catch (e) {
        return reject(thorin.error('REGISTRY.DISPATCH', 'Could not serialize payload.', e, 500));
      }
      if (_options instanceof thorin.Intent) {
        _options = {
          headers: {
            'X-Forwarded-For': _options.client('ip')
          }
        };
      }
      let dispatchCalls = 0,
        maxRetries = opt.retry;
      doDispatch(serviceNode, fetchOpt, (err, res) => {
        if (!err) return resolve(res);
        // if we have a fatal error, we try to retry if retry is in place.
        if (err.offline !== true) return reject(err);  // an application-level error.
        if (typeof maxRetries !== 'number' || maxRetries < 1) return reject(err);  // retry disabled.
        doRetryDispatch(serviceName, fetchOpt, 0, maxRetries, (err, res) => {
          if (err) return reject(err);
          resolve(res);
        });
      });
    });
  };
}