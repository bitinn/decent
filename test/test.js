
// test tools
var chai = require('chai');
var sinon = require('sinon');
var cap = require('chai-as-promised');
var sc = require('sinon-chai');
chai.use(cap);
chai.use(sc);

// BDD
var expect = chai.expect;

// test subjects
var decent = require('../index.js');
var EventEmitter = require('events').EventEmitter;
var Promise = require('native-or-bluebird');
var Redis = require('fakeredis');

// global vars
var queue;

describe('decent', function() {

	beforeEach(function() {
		// do not wait for redis connection, let client buffer command
		queue = decent('test');
	});

	afterEach(function() {
		// purge test values after each test
		return new Promise(function(resolve, reject) {
			// not efficient or atomic purge, but good enough
			queue.client.keys(queue.prefix + ':*', function(err, res) {
				if (err) {
					reject(err);
				} else if (!res || res.length === 0) {
					resolve();
				} else {
					// make sure all deletes are done
					var multi = queue.client.multi();
					res.forEach(function(key) {
						multi.del(key);
					});
					multi.exec(function(error, result) {
						if (error) {
							reject(error[0]);
						} else {
							resolve();
						}
					});
				}
			});
		});
	});

	describe('constructor', function() {
		it('should return a decent instance properly', function() {
			expect(queue.name).to.equal('test');
			expect(queue.port).to.equal(6379);
			expect(queue.host).to.equal('127.0.0.1');

			expect(queue.config).to.be.an('object');
			expect(queue.config.blockTimeout).to.equal(30);
			expect(queue.config.maxRetry).to.equal(3);

			expect(queue.opts).to.be.an('object');

			expect(queue.client).to.be.an.instanceof(EventEmitter);
			expect(queue.bclient).to.be.an.instanceof(EventEmitter);

			expect(queue.prefix).to.equal('dq:test');
			expect(queue.workQueue).to.equal('dq:test:work');
			expect(queue.runQueue).to.equal('dq:test:run');
			expect(queue.failQueue).to.equal('dq:test:fail');

			expect(queue.status_timeout).to.equal(1);
		});

		it('should allow custom redis options', function() {
			queue = decent('test', { port: '6379', host: 'localhost', connect_timeout: 5000 });

			expect(queue.port).to.equal('6379');
			expect(queue.host).to.equal('localhost');
			expect(queue.opts).to.have.property('connect_timeout', 5000);
		});

		it('should throw error if queue name is missing', function() {
			expect(decent).to.throw(Error);
		});

		it('should return an instance of event emitter', function() {
			expect(queue).to.be.an.instanceof(EventEmitter);
		});
	});

	describe('nextId', function() {
		it('should setup queue id and return it', function() {
			return expect(queue.nextId()).to.eventually.equal(1);
		});

		it('should increment queue id and return it', function() {
			queue.client.set(queue.prefix + ':id', 5);

			return expect(queue.nextId()).to.eventually.equal(6);
		});

		it('should reject if queue id is not number', function() {
			queue.client.hmset(queue.prefix + ':id', { a: 1 });

			return expect(queue.nextId()).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('nextJob', function() {
		it('should return the next job on queue', function() {
			queue.add({ a: 1 });
		
			return expect(queue.nextJob()).to.eventually.be.fulfilled;
		});

		it('should return the job properly formatted', function() {
			queue.add({ a: 1 })

			return queue.nextJob().then(function(job) {
				expect(job.id).to.equal(1);
				expect(job.data).to.deep.equal({ a: 1 });
				expect(job.retry).to.equal(0);
				expect(job.timeout).to.equal(60);
			});
		});

		it('should wait for next job to be available', function() {
			setTimeout(function() {
				queue.add({ a: 1 });
			}, 25);
			
			return expect(queue.nextJob()).to.eventually.be.fulfilled;
		});

		it('should block for n seconds before returning status_timeout', function() {
			var stub = sinon.stub(queue.bclient, 'brpoplpush', function(a1, a2, a3, cb) {
				setTimeout(function() {
					cb(null, null);
				}, 25);
			});

			return expect(queue.nextJob()).to.eventually.equal(queue.status_timeout);
		});

		it('should reject on connection failure', function() {
			var p = queue.nextJob();

			setTimeout(function() {
				queue.bclient.stream.destroy();
			}, 25);

			return expect(p).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('toClient', function() {
		it('should convert job into redis format', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 120
			};

			expect(queue.toClient(job)).to.deep.equal({
				id: 1
				, data: '{"a":1}'
				, retry: 0
				, timeout: 120
			});
		});

		it('should trigger error if job data is not serializable', function() {
			var testObj = {};
			testObj.key = 'value';
			testObj.cycle = testObj;

			var job = {
				id: 1
				, data: testObj
				, retry: 0
				, timeout: 60
			};

			expect(function() { queue.toClient(job) }).to.throw(Error);
		});
	});

	describe('fromClient', function() {
		it('should convert redis job into original format', function() {
			var job = {
				id: '1'
				, data: '{"a":1}'
				, retry: '0'
				, timeout: '120'
			};

			expect(queue.fromClient(job)).to.deep.equal({
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 120
			});
		});

		it('should trigger error if redis job data is invalid', function() {
			var job = {
				id: 1
				, data: 'a:1'
				, retry: 0
				, timeout: 60
			};

			expect(function() { queue.fromClient(job) }).to.throw(Error);
		});
	});

	describe('worker', function() {
		it('should register a job handler', function() {
			var stub = sinon.stub(queue, 'listen');
			var handler = function() {};

			queue.worker(handler);
			expect(queue.handler).to.equal(handler);
		});

		it('should throw error if handler is not function', function() {
			var stub = sinon.stub(queue, 'listen');
			var handler = 1;

			expect(function() { queue.worker(handler) }).to.throw(Error);
		});

		it('should throw error if handler exists', function() {
			var stub = sinon.stub(queue, 'listen');
			var handler = function() {};

			queue.handler = handler;
			expect(function() { queue.worker(handler) }).to.throw(Error);
		});

		it('should kick start queue listener', function() {
			var stub = sinon.stub(queue, 'listen');
			var handler = function() {};

			queue.worker(handler);
			expect(stub).to.have.been.calledOnce;
		});
	});

	describe('listen', function() {
		it('should kick start run process', function() {
			var stub = sinon.stub(queue, 'run');
			stub.returns(Promise.resolve(true));

			return queue.listen().then(function() {
				expect(stub).to.have.been.calledOnce;
			});
		});

		it('should emit event on error exit', function() {
			var error = new Error('some error');

			var stub = sinon.stub(queue, 'run');
			stub.returns(Promise.reject(error));

			var spy = sinon.spy();
			queue.on('queue exit', spy);

			return queue.listen().then(function() {
				expect(spy).to.have.been.calledOnce;
				expect(spy).to.have.been.calledWith(error);
			});
		});
	});

	describe('run', function() {
		it('should repeatedly run until error', function() {
			var error = new Error('some error');

			var s0 = sinon.stub(queue, 'nextJob');
			var s1 = sinon.stub(queue, 'handleStatus');
			var s2 = sinon.stub(queue, 'handleJob');
			s0.returns(Promise.resolve(true));
			s1.returns(Promise.resolve(true));
			s2.onCall(0).returns(Promise.resolve(true));
			s2.onCall(1).returns(Promise.reject(error));

			return queue.run().catch(function(err) {
				expect(s0).to.have.been.calledTwice;
				expect(s1).to.have.been.calledTwice;
				expect(s2).to.have.been.calledTwice;
				expect(err).to.equal(error);
			});
		});

		it('should repeatedly run until shutdown', function() {
			var p = function() {
				return new Promise(function(resolve, reject) {
					setTimeout(function() {
						resolve();
					}, 10);
				});
			};

			var s0 = sinon.stub(queue, 'nextJob', p);
			var s1 = sinon.stub(queue, 'handleStatus', p);
			var s2 = sinon.stub(queue, 'handleJob', p);

			var spy = sinon.spy();
			queue.on('queue stop', spy);

			setTimeout(function() {
				queue.shutdown = true;
			}, 25);

			return queue.run().then(function() {
				expect(s0).to.have.been.calledOnce;
				expect(s1).to.have.been.calledOnce;
				expect(s2).to.have.been.calledOnce;
				expect(spy).to.have.been.calledOnce;
			});
		});
	});

	describe('handleStatus', function() {
		it('should get next job again if input is status_timeout', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			var stub = sinon.stub(queue, 'nextJob');
			stub.returns(Promise.resolve(job));

			return queue.handleStatus(queue.status_timeout).then(function(res) {
				expect(stub).to.have.been.calledOnce;
				expect(res).to.equal(job);
			});
		});

		it('should pass on job object unchanged', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			return expect(queue.handleStatus(job)).to.equal(job);
		});
	});

	describe('handleJob', function() {
		it('should throw error if handler is missing', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			expect(function() { queue.handleJob(job) }).to.throw(Error);
		});

		it('should run handler to process job', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			var spy = sinon.spy();
			queue.handler = spy;

			return queue.handleJob(job).then(function() {
				expect(spy).to.have.been.calledOnce;
				expect(spy).to.have.been.calledWith(job);
			});
		});

		it('should emit job done event', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			queue.handler = function() {};

			var spy = sinon.spy();
			queue.on('queue ok', spy);

			return queue.handleJob(job).then(function() {
				expect(spy).to.have.been.calledOnce;
				expect(spy).to.have.been.calledWith(job);
			});
		});

		it('should move job to another queue if handler throw error', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			var error = new Error('some error');
			var s0 = sinon.stub();
			var s1 = sinon.stub(queue, 'moveJob');
			s0.throws(error);
			s1.returns(Promise.resolve(true));

			queue.handler = s0;

			return queue.handleJob(job).then(function() {
				expect(s0).to.have.been.calledOnce;
				expect(s0).to.have.been.calledWith(job);
				expect(s1).to.have.been.calledOnce;
				expect(s1).to.have.been.calledWith(job);
			});
		});

		it('should emit error from handler', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			var error = new Error('some error');
			var s0 = sinon.stub();
			var s1 = sinon.stub(queue, 'moveJob');
			var spy = sinon.spy();
			s0.throws(error);
			s1.returns(Promise.resolve(true));

			queue.handler = s0;
			queue.on('queue error', spy);

			return queue.handleJob(job).then(function() {
				expect(spy).to.have.been.calledOnce;
				expect(spy).to.have.been.calledWith(error);
			});
		});
	});

	describe('moveJob', function() {
		it('should move job into work queue when retry available', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			return queue.moveJob(job).then(function() {
				return queue.count('work').then(function(count) {
					expect(count).to.equal(1);
				});
			});
		});

		it('should move job into fail queue when retry limit reached', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 3
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			return queue.moveJob(job).then(function() {
				return queue.count('fail').then(function(count) {
					expect(count).to.equal(1);
				});
			});
		});

		it('should increment job retry count', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			return queue.moveJob(job).then(function() {
				return queue.get(job.id).then(function(job) {
					expect(job.retry).to.equal(1);
				});
			});
		});

		it('should reject on connection failure', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			var p = queue.moveJob(job);
			queue.client.stream.destroy();

			return expect(p).to.eventually.be.rejectedWith(Error);
		});

		it('should reject if move command return unexpected result', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			return expect(queue.moveJob(job)).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('remove', function() {
		it('should remove job from queue and purge job data', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			return queue.remove(job.id).then(function() {
				return queue.count('run').then(function(count) {
					expect(count).to.equal(0);
					return expect(queue.get(job.id)).to.eventually.be.rejectedWith(Error);
				});
			});
		});

		it('should reject on connection failure', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));
			queue.client.lpush(queue.runQueue, job.id);

			var p = queue.remove(job.id);
			queue.client.stream.destroy();

			return expect(p).to.eventually.be.rejectedWith(Error);
		});

		it('should reject if remove command return unexpected result', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			return expect(queue.remove(job.id)).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('stop', function() {
		it('should set shutdown to true', function() {
			queue.stop();
			expect(queue.shutdown).to.be.true;
		});
	});

	describe('count', function() {
		it('should return work queue job count by default', function() {
			return queue.add({ a: 1 }).then(function() {
				return expect(queue.count()).to.eventually.equal(1);
			});
		});

		it('should return queue job count for specified queue', function() {
			queue.client.lpush(queue.runQueue, 1);

			return expect(queue.count('run')).to.eventually.equal(1);
		});

		it('should reject if queue name is invalid', function() {
			return expect(queue.count('invalid')).to.eventually.be.rejectedWith(Error);
		});

		it('should reject if queue data is invalid', function() {
			queue.client.set(queue.workQueue, 1);

			return expect(queue.count()).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('get', function() {
		it('should reject if no id given', function() {
			return expect(queue.get()).to.eventually.be.rejectedWith(Error);
		});

		it('should return the job', function() {
			return queue.add({ a: 1 }).then(function(job) {
				return expect(queue.get(job.id)).to.eventually.be.fulfilled;
			});
		});

		it('should return the job properly formatted', function() {
			return queue.add({ a: 1 }).then(function(j1) {
				return queue.get(j1.id).then(function(j2) {
					expect(j2.id).to.equal(j1.id);
					expect(j2.data).to.deep.equal(j1.data);
					expect(j2.retry).to.equal(j1.retry);
					expect(j2.timeout).to.equal(j1.timeout);
				});
			});
		});

		it('should reject on connection failure', function() {
			var job = {
				id: 1
				, data: { a: 1 }
				, retry: 0
				, timeout: 60
			};

			queue.client.hmset(queue.prefix + ':' + job.id, queue.toClient(job));

			var p = queue.get(job.id);
			queue.client.stream.destroy();

			return expect(p).to.eventually.be.rejectedWith(Error);
		});

		it('should reject if job data is missing', function() {
			return expect(queue.get(1)).to.eventually.be.rejectedWith(Error);
		});

		it('should reject if job data is invalid', function() {
			var job = {
				id: '1'
				, data: 'a:1'
				, retry: '0'
				, timeout: '60'
			};

			queue.client.hmset(queue.prefix + ':' + job.id, job);

			return expect(queue.get(job.id)).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('add', function() {
		it('should reject empty data', function() {
			return expect(queue.add()).to.eventually.be.rejectedWith(Error);
		});

		it('should reject non-object data', function() {
			return expect(queue.add('invalid')).to.eventually.be.rejectedWith(Error);
		});

		it('should add a new job to queue', function() {
			return queue.add({ a: 1 }).then(function(job) {
				queue.client.hgetall(queue.prefix + ':' + job.id, function(err, res) {
					expect(res.id).to.equal('1');
					expect(res.data).to.equal(JSON.stringify({ a: 1 }));
					expect(res.retry).to.equal('0');
					expect(res.timeout).to.equal('60');
				});
			});
		});

		it('should return the added job', function() {
			return queue.add({ a: 1 }).then(function(job) {
				expect(job.id).to.equal(1);
				expect(job.data).to.deep.equal({ a: 1 });
				expect(job.retry).to.equal(0);
				expect(job.timeout).to.equal(60);
			});
		});

		it('should allow custom job options', function() {
			return queue.add({ a: 1 }, { retry: 1, timeout: 120 }).then(function(job) {
				expect(job.id).to.equal(1);
				expect(job.data).to.deep.equal({ a: 1 });
				expect(job.retry).to.equal(1);
				expect(job.timeout).to.equal(120);
			});
		});

		it('should overwrite existing job, and requeue job id', function() {
			return queue.add({ a: 1 }, { timeout: 120 }).then(function(job) {
				return queue.add({ b: 1 }, { id: job.id }).then(function() {
					queue.client.hgetall(queue.prefix + ':' + job.id, function(err, res) {
						expect(res.id).to.equal('1');
						expect(res.data).to.equal(JSON.stringify({ b: 1 }));
						expect(res.retry).to.equal('0');
						expect(res.timeout).to.equal('60');
					});
				});
			});
		});

		it('should increment job id on each call', function() {
			queue.add({ a: 1 });
			queue.add({ b: 1 });
			return queue.add({ c: 1 }).then(function(job) {
				expect(job.id).to.equal(3);
				expect(job.data).to.deep.equal({ c: 1 });
			});
		});

		it('should reject if data has cyclic structure', function() {
			var testObj = {};
			testObj.key = 'value';
			testObj.cycle = testObj;
			return expect(queue.add(testObj)).to.eventually.be.rejectedWith(Error);
		});

		it('should emit event when done', function() {
			var spy = sinon.spy();
			queue.on('add ok', spy);

			return queue.add({ a: 1 }).then(function(job) {
				expect(spy).to.have.been.calledOnce;
				expect(spy).to.have.been.calledWithMatch(job);
			});
		});

		it('should emit event when failed', function() {
			queue.client.set(queue.workQueue, 1);

			var spy = sinon.spy();
			queue.on('add error', spy);

			return expect(queue.add({ a: 1 })).to.eventually.be.rejectedWith(Error);
		});

		it('should reject on connection failure', function() {
			var p = queue.add({ a: 1 });
			queue.client.stream.destroy();

			return expect(p).to.eventually.be.rejectedWith(Error);
		});
	});

	describe('clientReady', function() {
		it('should emit client ready event', function() {
			var spy = sinon.spy();
			queue.on('client ready', spy);

			queue.client.emit('ready');

			expect(spy).to.have.been.calledOnce;
		});
	});

	describe('clientConnect', function() {
		it('should emit client ready event when no_ready_check is set', function() {
			var spy = sinon.spy();
			queue.on('client ready', spy);

			queue.opts.no_ready_check = true;
			queue.client.emit('connect');

			expect(spy).to.have.been.calledOnce;
		});
	});

	describe('clientError', function() {
		it('should emit client error event with redis client error', function() {
			var spy = sinon.spy();
			queue.on('client error', spy);

			var err = new Error('some error');
			queue.client.emit('error', err);

			var nonerr = 'not a error';
			queue.client.emit('error', nonerr);

			expect(spy).to.have.been.calledOnce;
			expect(spy).to.have.been.calledWith(err);
		});
	});

	describe('clientEnd', function() {
		it('should emit client close event', function() {
			var spy = sinon.spy();
			queue.on('client close', spy);

			queue.client.emit('end');

			expect(spy).to.have.been.calledOnce;
		});
	});

	describe('clientDrain', function() {
		it('should emit client pressure event when cmd queue is non-zero', function() {
			var spy = sinon.spy();
			queue.on('client pressure', spy);

			// on node v0.10+ spy should be called 3 times, 0-1-0 in that order
			// on node v0.8 spy can be called more than 3 times
			return queue.add({ a: 1 }).then(function() {
				expect(queue.idle).to.be.true;
				expect(spy).to.have.been.called;
				expect(spy).to.have.been.calledWith(1);
			});
		});
	});

	describe('clientIdle', function() {
		it('should emit client pressure event when no pending cmd', function() {
			var spy = sinon.spy();
			queue.on('client pressure', spy);

			return queue.add({ a: 1 }).then(function() {
				expect(queue.idle).to.be.true;
				expect(spy).to.have.been.called;
				expect(spy).to.have.been.calledWith(0);
			});
		});
	});

	describe('real world', function() {
		it('should process async jobs', function(done) {
			var handler = sinon.spy();
			queue.worker(handler);

			var spy = sinon.spy();
			queue.on('queue ok', spy);

			setTimeout(function() {
				queue.add({ a: 1 });
			}, 25);
			
			queue.on('queue ok', function(job) {
				expect(handler).to.have.been.calledOnce;
				expect(spy).to.have.been.calledOnce;
				expect(job.data).to.have.property('a', 1);

				queue.removeAllListeners('queue ok');
				queue.stop();
				done();
			});
		});

		it('should allow parallebl job creation', function() {
			var p = Promise.all([
				queue.add({ a: 1 })
				, queue.add({ b: 1 })
				, queue.add({ c: 1 })
				, queue.add({ d: 1 })
				, queue.add({ e: 1 })
			]);
			
			return p.then(function(res) {
				expect(res).to.have.length(5);
				return queue.count().then(function(count) {
					expect(count).to.equal(5);
				});
			});
		});
	});

	describe('wrap up', function() {
		it('should not leave test data in redis', function(done) {
			queue.client.keys(queue.prefix + ':*', function(err, res) {
				expect(err).to.be.null;
				expect(res).to.be.empty;
				done();
			});
		});
	});
});
