
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
Queue.prototype.nextId = function() {

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
		id: parseInt(job.id, 10)
		, data: JSON.parse(job.data)
		, retry: parseInt(job.retry, 10)
		, timeout: parseInt(job.timeout, 10)
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
	return this.nextId().then(function(id) {

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
					// client error
					if (err) {
						// only return the first error
						if (err.length > 0) {
							err = err[0];
						}

						self.emit('add error', err);
						reject(err);

					// command failure
					// we need to check each command is returning expected result
					// as err is null in this case, ref: http://git.io/bT5C4Q
					} else if (res[0] !== 'OK') {
						err = new Error('unable to set job item');
						self.emit('add error', err);
						reject(err);
					// response should be 0 or 1
					} else if (isNaN(parseInt(res[1], '10')) || res[1] > 1) {
						err = new Error('unable to purge duplicate job id');
						self.emit('add error', err);
						reject(err);
					// response should be number and at least 1
					} else if (isNaN(parseInt(res[2], '10')) || res[2] < 1) {
						err = new Error('unable to add job id');
						self.emit('add error', err);
						reject(err);
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

	var l = this.client.command_queue.length;
	if (l > 0) {
		this.idle = false;
		this.emit('client pressure', l);
	}

};

/**
 * Handle redis client idle event
 *
 * @return  Void
 */
Queue.prototype.clientIdle = function() {

	if (!this.idle) {
		this.idle = true;
		this.emit('client pressure', 0);
	}

};

