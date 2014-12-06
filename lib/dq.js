
/**
 * dq.js
 *
 * the client and worker object
 */

'use strict';

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

	// main redis client
	this.client = Redis.createClient(this.port, this.host, this.opts);

	this.client.on('ready', this.clientReady.bind(this));
	this.client.on('connect', this.clientConnect.bind(this));
	this.client.on('error', this.clientError.bind(this));
	this.client.on('end', this.clientEnd.bind(this));
	this.client.on('drain', this.clientDrain.bind(this));
	this.client.on('idle', this.clientIdle.bind(this));

	// client for blocking command only
	this.bclient = Redis.createClient(this.port, this.host, this.opts);

	// queue
	this.prefix = 'dq';

	this.queue = this.prefix + ':' + this.name;
	this.workQueue = this.queue + ':work';
	this.runQueue = this.queue + ':run';
	this.failQueue = this.queue + ':fail';

	// config
	this.blockTimeout = 30;
	this.maxRetry = 3;

	// status
	this.status_timeout = 1;

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
 * Retrieve the next job on work queue, put it on the run queue
 *
 * @return  Promise
 */
Queue.prototype.nextJob = function() {

	var self = this;

	return new Promise(function(resolve, reject) {

		self.bclient.brpoplpush(
			self.workQueue
			, self.runQueue
			, self.blockTimeout
			, function(err, id) {
				// client error
				if (err) {
					reject(err);

				// blocking timeout, return special code
				} else if (id === null) {
					resolve(self.status_timeout);

				} else {
					// get job
					self.client.hgetall(self.queue + ':' + id, function(err, job) {
						// client error
						if (err) {
							reject(err);

						// job data missing
						} else if (job === null) {
							reject(new Error('job data missing'));

						} else {
							// format job for client, handle invalid job
							try {
								job = self.fromClient(job);
							} catch(err) {
								reject(err);
							}
							
							resolve(job);
						}
					});
				}
			}
		);

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
 * Register a handler function that process each job
 *
 * @param   Function  handler  Process job data
 * @return  Void
 */
Queue.prototype.worker = function(handler) {

	if (typeof handler !== 'function') {
		throw new Error('worker must be a function');
	}

	if (this.handler) {
		throw new Error('worker can only be registered once');
	}

	this.handler = handler;

	// once the handler is registered, we can start processing jobs
	this.listen();

};

/**
 * Start listening for jobs on queue, handle worker function error
 *
 * @return  Promise
 */
Queue.prototype.listen = function() {

	var self = this;

	return this.run().catch(function(err) {
		self.emit('queue error', err);
	});

};

/**
 * Repeatedly retrieve new job from work queue then process it
 *
 * @return  Promise
 */
Queue.prototype.run = function() {

	var self = this;

	return this.nextJob()
		.then(function(res) {
			return self.handleStatus(res);
		})
		.then(function(job) {
			return self.handleJob(job);
		})
		.then(function() {
			return self.run();
		});

};

/**
 * Handle known status code from nextJob
 *
 * @param   Mixed  res  Result from nextJob
 * @return  Mixed
 */
Queue.prototype.handleStatus = function(res) {

	// blocking timeout, try again
	if (res === this.status_timeout) {
		return this.nextJob();

	// pass on result
	} else {
		return res;
	}

};

/**
 * Handle job from nextJob
 *
 * @param   Object   job  Formatted job
 * @return  Promise
 */
Queue.prototype.handleJob = function(job) {

	// worker process job
	if (this.handler) {
		try {
			this.handler(job);
		} catch(err) {
			// emit handler related error
			this.emit('queue error', err);

			// move job to next queue
			return this.moveJob(job);
		}
	}

	var self = this;

	// job done, remove it
	return new Promise(function(resolve, reject) {

		self.client.multi()
			.lrem(self.runQueue, 1, job.id)
			.del(self.queue + ':' + job.id)
			.exec(function(err, res) {
				// client error
				if (err) {
					// only return the first error
					if (err.length > 0) {
						err = err[0];
					}

					reject(err);

				// see Queue.prototype.add comments on why these check are necessary

				} else if (res[0] != 1) {
					err = new Error('unable to remove job id');
					reject(err);
				} else if (res[1] != 1) {
					err = new Error('unable to remove job data');
					reject(err);
				} else {
					resolve();
				}
			});

	});

};

/**
 * Move job from run queue to another queue
 *
 * @param   Object   job  Formatted job
 * @return  Promise
 */
Queue.prototype.moveJob = function(job) {

	var self = this;

	// job done, remove it
	return new Promise(function(resolve, reject) {

		var multi = self.client.multi();

		// check retry limit
		if (job.retry > self.maxRetry) {
			multi.rpoplpush(self.runQueue, self.failQueue);
		} else {
			multi.rpoplpush(self.runQueue, self.workQueue);
		}

		// update job retry count
		multi.hset(self.queue + ':' + job.id, 'retry', job.retry++);

		multi.exec(function(err, res) {
			// client error
			if (err) {
				// only return the first error
				if (err.length > 0) {
					err = err[0];
				}

				reject(err);

			// see Queue.prototype.add comments on why these check are necessary

			} else if (res[0] === null) {
				err = new Error('unable to job id does not exist on queue');
				reject(err);
			// response should be 0
			} else if (isNaN(parseInt(res[1], '10')) || res[1] > 0) {
				err = new Error('unable to update job retry count');
				reject(err);
			} else {
				resolve();
			}
		});

	});

};

/**
 * Re-run all previously failed jobs
 *
 * @return  Promise
 */
Queue.prototype.runFailJobs = function() {

	// TODO

}

/**
 * Report the current number of jobs in work queue
 *
 * @return  Promise
 */
Queue.prototype.count = function() {

	var self = this;

	return new Promise(function(resolve, reject) {

		self.client.llen(self.workQueue, function(err, res) {
			if (err) {
				reject(err);
			} else {
				resolve(res);
			}
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

	// note that queue id always increment, even if we don't use it
	return this.nextId().then(function(id) {

		// job structure
		var job = {
			id: opts.id || id
			, data: data
			, retry: opts.retry || 0
			, timeout: opts.timeout || 60
		};

		// format job for redis, invalid data will reject promise
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
					// response should be a number and at least 1
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

