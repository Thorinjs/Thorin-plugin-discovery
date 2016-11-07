'use strict';
/**
 * This creates an authorization middleware that will check that the incoming
 * request is made by a microservice within the cluster. We perform the check by checking
 * the access token as well as the user-agent
 */
module.exports = function (thorin, opt, pluginObj) {
  const logger = thorin.logger(opt.logger),
    security = require('../security'),
    dispatcher = thorin.dispatcher;

  /*
   * Verifies the incoming HTTP Authorization header to see if it is an internal service or not.
   * Returns: {service data object}
   * */
  pluginObj.verifyToken = function verifyToken(accessToken, action) {
    let serviceData = security.verify(accessToken, action);
    if (!serviceData) return null;
    return serviceData;
  };

  /*
   * Signs the payload with the current token.
   * */
  pluginObj.sign = function SignPayload(payload, serviceName) {
    let signature = security.sign(payload, serviceName || thorin.app);
    if(!signature) return null;
    return signature;
  };

  /*
   * All you need to do in your actions is to add
   *   .authorization('discovery.proxy')
   * and all the incoming requests will be filtered by this.
   * */
  const PROXY_ERROR = thorin.error('DISCOVERY.PROXY', 'Request not authorized.', 403);
  dispatcher
    .addAuthorization('discovery#proxy')
    .use((intentObj, next) => {
      const clientData = intentObj.client(),
        tokenType = intentObj.authorizationSource,
        accessToken = intentObj.authorization;
      if (clientData.headers['user-agent'] !== 'thorin-discovery') return next(PROXY_ERROR);
      if (tokenType !== 'TOKEN') return next(PROXY_ERROR);
      let serviceData = pluginObj.verifyToken(accessToken, intentObj.action);
      if (!serviceData) {
        logger.warn(`Received invalid proxy request for ${intentObj.action} from: ${clientData.ip}`);
        logger.warn(clientData, intentObj.rawInput);
        return next(PROXY_ERROR);
      }
      intentObj.data('proxy_name', serviceData.n);
      if (serviceData.t) {
        intentObj.data('proxy_service', serviceData.t);
      }
      intentObj.resultHeaders('connection', 'keep-alive');
      next();
    });
}