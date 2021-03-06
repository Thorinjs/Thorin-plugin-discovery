'use strict';
const PAGINATION_FIELDS = ['start_date', 'end_date', 'limit', 'page', 'order', 'order_by'];
/**
 * The discovery plugin will extend the thorin.Action class, ading additonal functionality such as request proxying
 * The request proxying is actually adding a custom middleware in the use chain, that will use the input of the intent
 * to proxy the data to a given registry service.
 * The system also has retry functionality in place.
 */
module.exports = function (thorin, opt, pluginObj) {
  const logger = thorin.logger(opt.logger),
    security = require('./security'),
    Action = thorin.Action;

  const HANDLER_TYPE = 'proxy';

  Action.HANDLER_TYPE.PROXY_DISCOVERY = 'proxy.discovery';

  class ThorinAction extends Action {

    /**
     * This will be available for all actions, it will allow one service's action handlers
     * to proxy the incoming intent to another service within the discovery system.
     * NOTE:
     *  the name MUST contain "discovery#" to identify that we're going to
     *  proxy the request to a specific service, and not to another internal action.
     *  The pattern is: "discovery#{serviceName}"
     * Ex:
     *
     *  thorin.dispatcher.addAction('myAction')
     *      .use((intentObj, next) => {
     *        intentObj.input('someValue', 1);    // override the intent's input.
     *        next();
     *      })
     *      .before('proxy', (intentObj, serviceData) => {
     *        console.log('Will proxy action to ${serviceData.ip});
     *      })
     *      .proxy('discovery#myOtherService', {
     *        action: 'some.other.custom.action'  // it defaults to the current action's name
     *      })
     *      .after('proxy', (intentObj, response) => {
     *        console.log(`Proxy successful. Response:`, response);
     *      })
     *      .use((intentObj) => {
     *        console.log("myOtherService responded with: ", intentObj.result());
     *        // here is where we can mutate the result of the intent to send back to the client.
     *        intentObj.send();
     *      });
     *      OPTIONS:
     *        - action=string -> the target action name found on the service app. If not specified, fetch action from intentObj.action
     *        - payload=object -> the base payload that will override the intent input.
     *        - rawInput=false -> should we use intentObj.input() or intentObj.rawInput
     *        - raw=false -> if set to true, we will proxy all headers/ip/rawInput/etc.
     *        - download=true -> if we will receive a content-disposition header, we will proxy it, along with the raw result
     *        - fields: {} -> a key-value object that will convert the key into the value of the key to be transfered.
     *                      This is essentially a mapping between services.
     *                      Eg:
     *                        fields: {
     *                          code: 'action_code',        -> input.code will be converted to input.action_code
     *                          message: 'action_message'   -> input.message will be converted into action_message
     *                        }
     *              NOTE: special fields:
     *                    - _pagination -> white-lists all pagination fields (start_date, end_date, limit, page, order, order_by)
     * */
    proxy(proxyServiceName, opt) {
      if (typeof proxyServiceName !== 'string' || !proxyServiceName) {
        logger.error(`proxy() of action ${this.name} must have a valid string for the proxy service name`);
        return this;
      }
      let tmp = proxyServiceName.split('#'),
        proxyName = tmp[0],
        serviceName = tmp[1];
      if (proxyName !== 'discovery') {
        if (typeof super.proxy === 'function') {
          return super.proxy.apply(this, arguments);
        }
        logger.warn(`proxy() must contain a service name with the pattern: discovery#{serviceName} [current: ${proxyServiceName}]`);
        return this;
      }

      let options = Object.assign({}, {
        serviceName: serviceName,
        rawInput: true,
        raw: false,
        //action: this.name,  // will be set in intentobj.action
        exclude: [],
        payload: {}
      }, opt || {});
      this.stack.push({
        name: proxyServiceName,
        type: Action.HANDLER_TYPE.PROXY_DISCOVERY,
        opt: options
      });
      return this;
    }


    /*
     * Runs our custom proxy middleware function.
     * */
    _runCustomType(intentObj, handler, done) {
      if (handler.type !== Action.HANDLER_TYPE.PROXY_DISCOVERY) {
        return super._runCustomType.apply(this, arguments);
      }
      let opt = handler.opt,
        serviceName = opt.serviceName,
        actionName = opt.action || intentObj.action,
        intentInput = {};
      if (opt.raw === true || opt.rawInput === true || typeof opt.fields === 'object' && opt.fields) {
        intentInput = intentObj.rawInput;
      } else {
        intentInput = intentObj.input();
      }
      let payload = opt.payload || {};
      if (typeof opt.fields === 'object' && opt.fields) {
        Object.keys(opt.fields).forEach((keyName) => {
          if (keyName === '_pagination') {
            for (let i = 0, len = PAGINATION_FIELDS.length; i < len; i++) {
              let pagKey = PAGINATION_FIELDS[i];
              if (typeof intentInput[pagKey] === 'undefined' || intentInput[pagKey] == null) continue;
              payload[pagKey] = intentInput[pagKey];
            }
            return;
          }
          if (typeof intentInput[keyName] === 'undefined') return;
          let newKeyName = opt.fields[keyName];
          if (newKeyName === true) {
            payload[keyName] = intentInput[keyName];
          } else if (typeof newKeyName === 'string') {
            payload[newKeyName] = intentInput[keyName];
          }
        });
      } else {
        payload = Object.assign({}, intentInput, opt.payload);
      }
      if (opt.exclude instanceof Array) {
        for (let i = 0; i < opt.exclude.length; i++) {
          let keyName = opt.exclude[i];
          if (typeof payload[keyName] !== 'undefined') delete payload[keyName];
        }
      }
      this._runHandler(
        'before',
        HANDLER_TYPE,
        intentObj,
        serviceName,
        actionName,
        payload
      );
      /* Perform the dispatch to the service using the discovery plugin. */

      let _opt;
      if (opt.raw === true) {
        let client = intentObj.client();
        _opt = {};
        _opt.headers = client.headers || {};
        _opt.headers['content-type'] = 'application/json';
        _opt.headers['x-forwarded-for'] = client.ip;
        _opt.headers['connection'] = 'keep-alive';
        _opt.headers['cache-control'] = 'no-cache';
        if (_opt.headers['content-length']) delete _opt.headers['content-length'];
      } else {
        _opt = intentObj;
      }
      let pObj;
      if (opt.raw === true) {
        let _data = {
          type: actionName,
          payload
        };
        if (intentObj.hasFilter()) {
          _data.filter = intentObj.rawFilter;
        }
        let serviceKey = pluginObj.getServiceKey();
        if (serviceKey) {
          _opt.headers['x-discovery-token'] = security.sign(_data, opt.service);
        }
        pObj = pluginObj.rawDispatch(serviceName, _data, _opt);
      } else {
        pObj = pluginObj.dispatch(serviceName, actionName, payload, _opt);
      }
      pObj.then((data) => {
        let res = data.result,
          headers = data.headers,
          contentType = headers.get('content-type');
        if (contentType && contentType.indexOf('json') !== -1) {
          opt.raw = true;
        }
        if (opt.download === true) {
          intentObj.rawResult(res);
          intentObj.resultHeaders('Content-Type', contentType);
          intentObj.resultHeaders('Content-Disposition', headers.get('content-disposition'));
          //intentObj.resultHeaders('Content-Length', headers.get('content-length'));
          return;
        }
        if (typeof res === 'object' && res) {
          if (typeof res.meta !== 'undefined') {
            intentObj.setMeta(res.meta);
          }
          if (typeof res.result !== 'undefined') {
            intentObj.result(res.result);
          }
        }
        if (opt.raw === true && opt.headers instanceof Array) {
          let headers = data.headers;
          try {
            for (let i = 0; i < opt.headers.length; i++) {
              let name = opt.headers[i];
              let val = headers.get(name);
              if (val != null) {
                intentObj.resultHeaders(name, val);
              }
            }
          } catch (e) {
          }
        }
      }).catch((e) => intentObj.error(e))
        .finally(() => {
          this._runHandler(
            'after',
            HANDLER_TYPE,
            intentObj,
            serviceName,
            actionName,
            payload
          );
          done();
        });
    }
  }

  thorin.Action = ThorinAction;
};