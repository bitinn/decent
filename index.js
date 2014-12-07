
/**
 * index.js
 *
 * export main lib
 */

var Decent = require('./lib/decent');

module.exports = factory;

/**
 * Create an instance of Decent
 *
 * @param   String  name  Name of this queue
 * @param   Object  opts  Redis options
 * @return  Object
 */
function factory(name, opts) {

	return new Decent(name, opts);

};
