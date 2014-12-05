
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

		self.client.incr(self.queue + ':id', function(err, res) {
			if (err) {
				reject(err);
			} else {
				resolve(res);
			}			
		});

	});

};

/**
 * Convert job data into a format supported by redis client
 *
 * @param   Object  job  Queue format
 * @return  Object
 */
Queue.prototype.toClient = function(job) {

	// all values must be primitive type
	return {
		id: job.id
		, data: JSON.stringify(job.data)
		, retry: job.retry
		, timeout: job.timeout
	};

};

/**
 * Convert redis data into the original job format
 *
 * @param   Object  job  Redis format
 * @return  Object
 */
Queue.prototype.fromClient = function(job) {

	// values in redis are stored as string
	return {
		id: parseInt(job.id)
		, data: JSON.parse(job.data)
		, retry: parseInt(job.retry)
		, timeout: parseInt(job.timeout)
	};

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

	// note that queue id always increment, even if we don't use it
	return this.getId().then(function(id) {

		// job structure
		var job = {
			id: opts.id || id
			, data: data
			, retry: opts.retry || 0
			, timeout: opts.timeout || 60
		};

		// what we put onto redis, value must be primitive
		var rjob = self.toClient(job);

		// add job as hash, push its id onto queue
		// note that overwrite existing job will requeue job id
		return new Promise(function(resolve, reject) {

			self.client.multi()
				.hmset(self.queue + ':' + rjob.id, rjob)
				.lrem(self.workQueue, 1, rjob.id)
				.lpush(self.workQueue, rjob.id)
				.exec(function(err, res) {
					// note that err is null when some command fails
					// res will contain strings of error messages
					// this is due to a redis client bug, ref: http://git.io/bT5C4Q

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

