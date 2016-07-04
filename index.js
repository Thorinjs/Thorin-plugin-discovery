'use strict';
/**
 * Created by Adrian on 19-Mar-16.
 */
module.exports = function (thorin, opt, pluginName) {
  opt = thorin.util.extend({
    logger: pluginName || 'discovery',
  }, opt);
  const logger = thorin.logger(opt.logger),
    pluginObj = {};

  return pluginObj;
};
module.exports.publicName = 'discovery';
