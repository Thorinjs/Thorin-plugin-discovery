'use strict';
/**
 * The discovery plugin will extend the thorin.Action class, ading additonal functionality such as request proxying
 * The request proxying is actually adding a custom middleware in the use chain, that will use the input of the intent
 * to proxy the data to a given registry service.
 * The system also has retry functionality in place.
 */
module.exports = function(thorin, opt, pluginObj) {
  const logger = thorin.logger(opt.logger),
    Action = thorin.Action;

  Action.HANDLER_TYPE.PROXY = 'proxy'

  class ThorinAction extends Action {

    /**
     * This will be available for all actions, it will allow one service's action handlers
     * to proxy the incoming intent to another service within the discovery system.
     * NOTE:
     *  the name MUST contain "service:" to identify that we're going to
     *  proxy the request to a specific service, and not to another internal action.
     *  The pattern is: "service:{serviceName}"
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
     *      .proxy('service:myOtherService', {
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
     *        - action=string -> the target action name found on the service app
     *        - payload=object -> the base payload that will override the intent input.
     *        - rawInput=false -> should we use intentObj.input() or intentObj.rawInput
     * */
    proxy(proxyServiceName, opt) {
      if (typeof proxyServiceName !== 'string' || !proxyServiceName) {
        logger.error(`proxy() of action ${this.name} must have a valid string for the proxy service name`);
        return this;
      }
      let serviceName = proxyServiceName.split('service:')[1];
      if (typeof serviceName !== 'string' || !serviceName) {
        if (typeof super.proxy === 'function') {
          return super.proxy.apply(this, arguments);
        }
        logger.warn(`proxy() must contain a service name with the pattern: service:{serviceName} [current: ${proxyServiceName}]`);
        return this;
      }

      let options = Object.assign({}, {
        serviceName: serviceName,
        rawInput: true,
        action: this.name,
        payload: {}
      }, opt || {});
      this.stack.push({
        name: proxyServiceName,
        type: Action.HANDLER_TYPE.PROXY,
        opt: options
      });
      return this;
    }

    /*
     * Runs our custom proxy middleware function.
     * */
    _runCustomType(intentObj, handler, done) {
      if (handler.type !== Action.HANDLER_TYPE.PROXY) {
        return super._runCustomType.apply(this, arguments);
      }
      let opt = handler.opt,
        serviceName = opt.serviceName,
        actionName = opt.action,
        intentInput = opt.rawInput ? intentObj.rawInput : intentObj.input(),
        payload = Object.assign({}, intentInput, opt.payload);
      this._runHandler(
        'before',
        Action.HANDLER_TYPE.PROXY,
        intentObj,
        serviceName,
        actionName,
        payload
      );
      /* Perform the dispatch to the service using the discovery plugin. */
      pluginObj
        .dispatch(serviceName, actionName, payload)
        .then((res) => {
          if (typeof res.meta !== 'undefined') {
            intentObj.setMeta(res.meta);
          }
          if (typeof res.result !== 'undefined') {
            intentObj.result(res.result);
          }
        })
        .catch((e) => intentObj.error(e))
        .finally(() => {
          this._runHandler(
            'after',
            Action.HANDLER_TYPE.PROXY,
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