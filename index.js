
/**
 * index.js
 *
 * export main lib
 */

var DQ = require('./lib/dq');

module.exports = factory;

/**
 * Create an instance of DQ
 *
 * @param   String  name  Name of this queue
 * @param   Object  opts  Redis options
 * @return  Object
 */
function factory(name, opts) {

	return new DQ(name, opts);

};
