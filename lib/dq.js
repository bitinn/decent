
/**
 * dq.js
 *
 * the client and worker object
 */

var Redis = require('redis');
var Promise = require('native-or-bluebird');
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;

inherits(Queue, EventEmitter);

module.exports = Queue;

/**
 * Create an instance of Queue
 *
 * @param   String  name  Name of this queue
 * @param   Object  opts  Redis options
 * @return  Object
 */
function Queue(name, opts) {

	if (!name) {
		throw new Error('queue name required');
	}

	opts = opts || {};

	// config
	this.name = name;
	this.port = opts.port || 6379;
	this.host = opts.host || '127.0.0.1';
	this.opts = opts;

	// redis
	this.client = Redis.createClient(this.port, this.host, this.opts);

	this.client.on('ready', this.clientReady.bind(this));
	this.client.on('connect', this.clientConnect.bind(this));
	this.client.on('error', this.clientError.bind(this));
	this.client.on('end', this.clientEnd.bind(this));
	this.client.on('drain', this.clientDrain.bind(this));
	this.client.on('idle', this.clientIdle.bind(this));

	// queue
	this.prefix = 'dq';

	this.queue = this.prefix + ':' + this.name;
	this.workQueue = this.queue + ':work';
	this.runQueue = this.queue + ':run';
	this.failQueue = this.queue + ':fail';

}

/**
 * Increment queue id and return it
 *
 * @return  Promise
 */
Queue.prototype.getId = function() {

	var self = this;

	return new Promise(function(resolve, reject) {

		self.client.incr(this.queue + ':id', function(res) {
			if (res instanceof Error) {
				reject(res);
			}

			resolve(res);
		});

	});

};

/**
 * Add a job onto the work queue, overwrite duplicate job
 *
 * @param   Object   data  Actual data for worker to process
 * @param   Object   opts  Additional job options
 * @return  Promise
 */
Queue.prototype.add = function(data, opts) {

	data = data || {};
	opts = opts || {};

	var self = this;

	return this.getId().then(function(id) {

		// job structure
		var job = {
			id: id
			, data: data
			, retry: opts.retry || 0
			, timeout: opts.timeout || 60
		};

		// add job as hash, make sure it only append once in list
		return new Promise(function(resolve, reject) {

			self.client.multi()
				.hmset(this.queue + ':' + job.id, job)
				.lrem(this.workQueue, 1, job.id)
				.lpush(this.workQueue, job.id)
				.exec(function(err, res) {
					// only return the first error
					if (err) {
						self.emit('add error', err[0]);
						reject(err[0])
					// return the job object
					} else {
						self.emit('add ok', job);
						resolve(job);
					}
				});

		});

	})

};

/**
 * Handle redis client ready event
 *
 * @return  Void
 */
Queue.prototype.clientReady = function() {

	if (!this.opts.no_ready_check) {
		this.emit('client ready');
	}

};

/**
 * Handle redis client connect event
 *
 * @return  Void
 */
Queue.prototype.clientConnect = function() {

	if (this.opts.no_ready_check) {
		this.emit('client ready');
	}

};

/**
 * Handle redis client error event
 *
 * @param   Object  err  Error from redis client
 * @return  Void
 */
Queue.prototype.clientError = function(err) {

	if (err instanceof Error) {
		this.emit('client error', err);
	}

};

/**
 * Handle redis client end event
 *
 * @return  Void
 */
Queue.prototype.clientEnd = function() {

	this.emit('client close');

};

/**
 * Handle redis client drain event
 *
 * @return  Void
 */
Queue.prototype.clientDrain = function() {

	// TODO: rate limiting

};

/**
 * Handle redis client idle event
 *
 * @return  Void
 */
Queue.prototype.clientIdle = function() {

	// TODO: recover from rate limiting

};

