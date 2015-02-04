
/**
 * decent.js
 *
 * the client and worker object
 */

'use strict';

var Redis = require('redis');
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

	// allow call as function
	if (!(this instanceof Queue))
		return new Queue(name, opts);

	if (!name) {
		throw new Error('queue name is required');
	}

	opts = opts || {};

	// basic
	this.name = name;
	this.port = opts.port || 6379;
	this.host = opts.host || '127.0.0.1';

	// queue config
	this.config = {
		blockTimeout: opts.blockTimeout || 60
		, maxRetry: opts.maxRetry || 3
	};

	// redis options
	this.opts = opts;

	// main redis client
	this.client = Redis.createClient(this.port, this.host, this.opts);

	// client for blocking command only
	this.bclient = Redis.createClient(this.port, this.host, this.opts);

	// queue name
	this.prefix = 'dq:' + this.name;
	this.workQueue = this.prefix + ':work';
	this.runQueue = this.prefix + ':run';
	this.failQueue = this.prefix + ':fail';

	// status code
	this.status_timeout = 1;

	// queue status
	this.shutdown = false;
	this.running = false;

}

/**
 * Add a job onto the work queue, overwrite duplicate job
 *
 * @param   Object   data  Actual data for worker to process
 * @param   Object   opts  Additional job options
 * @return  Promise
 * @api     Public
 */
Queue.prototype.add = function(data, opts) {

	var self = this;

	// note that queue id always increment, even if we don't use it
	return this.nextId().then(function(id) {

		if (!data || typeof data !== 'object') {
			throw new Error('job data payload must be an object');
		}

		opts = opts || {};

		// job structure
		var job = {
			id: opts.id || id
			, data: data
			, retry: opts.retry || 0
			, timeout: opts.timeout || 60
			, queue: self.workQueue
		};

		// format job for redis, invalid data will reject promise
		var rjob = self.toClient(job);

		// add job as hash, push its id onto queue
		// note that overwrite existing job will requeue job id
		return new Queue.Promise(function(resolve, reject) {

			self.client.multi()
				.hmset(self.prefix + ':' + rjob.id, rjob)
				.lrem(self.workQueue, 1, rjob.id)
				.lpush(self.workQueue, rjob.id)
				.exec(function(err, res) {
					// client error
					if (err) {
						reject(err[0]);

					// command failure
					// we need to check commands are returning expected result
					// as err is null in this case, ref: http://git.io/bT5C4Q

					// duplicate job id should be purged
					} else if (isNaN(parseInt(res[1], '10')) || res[1] > 1) {
						err = new Error('fail to remove duplicate job id from queue');
						reject(err);
					} else {
						resolve(job);
					}
				});

		});

	})

};

/**
 * Remove a job from queue given the job id
 *
 * @param   Number   id    Job id
 * @param   String   name  Queue name
 * @return  Promise
 * @api     Public
 */
Queue.prototype.remove = function(id, name) {

	name = name || 'work';
	var self = this;

	// job done, remove it
	return new Queue.Promise(function(resolve, reject) {

		if (!self[name + 'Queue']) {
			reject(new Error('invalid queue name'));
			return;
		}

		self.client.multi()
			.lrem(self[name + 'Queue'], 1, id)
			.del(self.prefix + ':' + id)
			.exec(function(err, res) {
				// see prototype.add on why verbose checks are needed
				// client error
				if (err) {
					// only return the first error
					reject(err[0]);

				// command error
				} else if (res[0] != 1) {
					err = new Error('job id missing from queue');
					reject(err);
				} else if (res[1] != 1) {
					err = new Error('job data missing from redis');
					reject(err);
				} else {
					resolve();
				}
			});

	});

};

/**
 * Report the current number of jobs in work queue
 *
 * @param   String   name  Queue name
 * @return  Promise
 * @api     Public
 */
Queue.prototype.count = function(name) {

	name = name || 'work';
	var self = this;

	return new Queue.Promise(function(resolve, reject) {

		if (!self[name + 'Queue']) {
			reject(new Error('invalid queue name'));
			return;
		}

		self.client.llen(self[name + 'Queue'], function(err, res) {
			if (err) {
				reject(err);
			} else {
				resolve(res);
			}
		});

	});

};

/**
 * Return job data without removing it from redis
 *
 * @param   Number   id  Job id
 * @return  Promise
 * @api     Public
 */
Queue.prototype.get = function(id) {

	var self = this;

	return new Queue.Promise(function(resolve, reject) {

		if (!id) {
			reject(new Error('job id required'));
			return;
		}

		// get job
		self.client.hgetall(self.prefix + ':' + id, function(err, job) {
			// client error
			if (err) {
				reject(err);

			} else if (job === null) {
				reject(new Error('job data missing from redis'));

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

	});

};

/**
 * Stop queue processing gracefully
 *
 * @return  Void
 * @api     Public
 */
Queue.prototype.stop = function() {

	this.shutdown = true;

};

/**
 * Restart queue processing
 *
 * @return  Void
 * @api     Public
 */
Queue.prototype.restart = function() {

	// prevent duplicate worker
	if (this.running) {
		throw new Error('worker is already running');
	}

	this.start();

};

/**
 * Register a handler function that process each job
 *
 * @param   Function  handler  Process job data
 * @return  Void
 * @api     Public
 */
Queue.prototype.worker = function(handler) {

	if (typeof handler !== 'function') {
		throw new Error('job handler must be a function');
	}

	if (this.handler) {
		throw new Error('job handler can only be registered once');
	}

	this.handler = handler;

	// once the handler is registered, we can start processing jobs
	this.start();

};

/**
 * Start listening for jobs on queue, handle worker function error
 *
 * @return  Void
 * @api     Private
 */
Queue.prototype.start = function() {

	var self = this;

	this.running = true;
	this.emit('queue start');

	this.run();

};

/**
 * Repeatedly retrieve new job from work queue then process it
 *
 * @return  Void
 * @api     Private
 */
Queue.prototype.run = function() {

	var self = this;

	// loop
	this.recoverJob()
		.then(function(res) {
			return self.readJob(res);
		})
		.then(function(job) {
			return self.handleJob(job);
		})
		.then(function() {
			// handle graceful shutdown
			if (self.shutdown) {
				self.shutdown = false;
				self.running = false;
				self.emit('queue stop');
				return;
			}
			// tail recursion
			self.run();
		}, function(err) {
			// exit queue
			self.running = false;
			self.emit('queue exit', err);
		});

};

/**
 * Wait for job on work queue, loop until found
 *
 * @param   Mixed    res  Can be empty, status code or job
 * @return  Promise
 * @api     Private
 */
Queue.prototype.readJob = function(res) {

	var self = this;

	// first run, or blocking timeout
	if (!res || res === this.status_timeout) {
		return this.nextJob().then(function(res) {
			return self.readJob(res);
		});

	// pass on job object
	} else {
		return Queue.Promise.resolve(res);
	}

};

/**
 * Process job with handler
 *
 * @param   Object   job  Formatted job
 * @return  Promise
 * @api     Private
 */
Queue.prototype.handleJob = function(job) {

	var self = this;

	// this promise always resolve, errors are handled
	return new Queue.Promise(function(resolve, reject) {

		// start working on job
		self.emit('queue work', job);

		if (!self.handler) {
			reject(new Error('job handler must be registered first'));
			return;
		}

		// support job timeout
		if (job.timeout > 0) {
			setTimeout(function() {
				reject(new Error('job timeout threshold reached'));
			}, job.timeout * 1000);
		}

		// callback function for async worker
		var done = function(input) {
			if (input instanceof Error) {
				reject(input);
			} else {
				resolve();
			}
		};

		// catch worker error
		try {
			self.handler(job, done);
		} catch(err) {
			reject(err);
		}

	}).then(function() {

		// job done, remove it and emit event
		return self.remove(job.id, 'run').then(function() {
			self.emit('queue ok', job);
		});

	}).catch(function(err) {

		// job failure, move job to appropriate queue
		return self.moveJob(job).then(function(job) {
			if (job.queue === self.failQueue) {
				self.emit('queue failure', err, job);
			} else {
				self.emit('queue error', err, job);
			}
		});

	});

};

/**
 * Move job from run queue to another queue
 *
 * @param   Object   job  Formatted job
 * @return  Promise
 * @api     Private
 */
Queue.prototype.moveJob = function(job) {

	var self = this;

	return new Queue.Promise(function(resolve, reject) {

		var multi = self.client.multi();

		// check retry limit, decide next queue
		if (job.retry >= self.config.maxRetry) {
			multi.rpoplpush(self.runQueue, self.failQueue);
			job.queue = self.failQueue;
		} else {
			multi.rpoplpush(self.runQueue, self.workQueue);
			job.queue = self.workQueue;
		}

		// update job retry count
		job.retry++;
		multi.hset(self.prefix + ':' + job.id, 'retry', job.retry);
		multi.hset(self.prefix + ':' + job.id, 'queue', job.queue);

		multi.exec(function(err, res) {
			// see prototype.add on why verbose checks are needed
			// client error
			if (err) {
				// only return the first error
				reject(err[0]);

			// command error
			} else if (res[0] === null) {
				err = new Error('job id missing from queue');
				reject(err);
			} else if (isNaN(parseInt(res[1], '10')) || res[1] > 0) {
				err = new Error('partial job data, retry count missing');
				reject(err);
			} else if (isNaN(parseInt(res[2], '10')) || res[2] > 0) {
				err = new Error('partial job data, queue name missing');
				reject(err);
			} else {
				resolve(job);
			}
		});

	});

};

/**
 * Recover job from runQueue back to start of workQueue
 *
 * @return  Promise
 * @api     Private
 */
Queue.prototype.recoverJob = function() {

	var self = this;

	return this.count('run').then(function(count) {

		// nothing to do if last session shutdown gracefully
		if (count === 0) {
			return;

		// by design there should only be at max 1 job in runQueue
		} else if (count > 1) {
			return Queue.Promise.reject(
				new Error('more than 1 job in queue, purge manually')
			);

		// move the job to work queue, note that retry count does not increase
		} else {
			return new Queue.Promise(function(resolve, reject) {
				self.client.rpoplpush(self.runQueue, self.workQueue, function(err, res) {
					if (err) {
						reject(err);
					} else if (res === null) {
						reject(new Error('job id missing from queue')); 
					} else {
						resolve();
					}
				});
			});
		}

	});

};

/**
 * Increment queue id and return it
 *
 * @return  Promise
 * @api     Private
 */
Queue.prototype.nextId = function() {

	var self = this;

	return new Queue.Promise(function(resolve, reject) {

		self.client.incr(self.prefix + ':id', function(err, res) {
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
 * @api     Private
 */
Queue.prototype.nextJob = function() {

	var self = this;

	return new Queue.Promise(function(resolve, reject) {

		self.bclient.brpoplpush(
			self.workQueue
			, self.runQueue
			, self.config.blockTimeout
			, function(err, id) {
				// client error
				if (err) {
					reject(err);

				// blocking timeout, return special code
				} else if (id === null) {
					resolve(self.status_timeout);

				} else {
					resolve(self.get(id));
				}
			}
		);

	});

};

/**
 * Convert job data into a format supported by redis client
 *
 * @param   Object   job  Queue format
 * @return  Object
 * @api     Private
 */
Queue.prototype.toClient = function(job) {

	// all values must be primitive type
	return {
		id: job.id
		, data: JSON.stringify(job.data)
		, retry: job.retry
		, timeout: job.timeout
		, queue: job.queue
	};

};

/**
 * Convert redis data into the original job format
 *
 * @param   Object   job  Redis format
 * @return  Object
 * @api     Private
 */
Queue.prototype.fromClient = function(job) {

	// values in redis are stored as string
	return {
		id: parseInt(job.id, 10)
		, data: JSON.parse(job.data)
		, retry: parseInt(job.retry, 10)
		, timeout: parseInt(job.timeout, 10)
		, queue: job.queue
	};

};

// allow custom promise module
Queue.Promise = global.Promise;
