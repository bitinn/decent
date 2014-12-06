
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
var dq = require('../index.js');
var EventEmitter = require('events').EventEmitter;
var Promise = require('native-or-bluebird');

// global vars
var queue;

describe('dq', function() {

	beforeEach(function() {
		// do not wait for redis connection, let client buffer command
		queue = dq('test');
	});

	afterEach(function() {
		// purge test values after each test
		return new Promise(function(resolve, reject) {
			// not efficient or atomic purge, but good enough
			queue.client.keys('dq:test:*', function(err, res) {
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
		it('should return a dq instance properly', function() {
			expect(queue.name).to.equal('test');
			expect(queue.port).to.equal(6379);
			expect(queue.host).to.equal('127.0.0.1');
		});

		it('should allow custom redis options', function() {
			queue = dq('test', { port: '6379', host: 'localhost', connect_timeout: 5000 });

			expect(queue.port).to.equal('6379');
			expect(queue.host).to.equal('localhost');
			expect(queue.opts).to.be.an('object');
			expect(queue.opts).to.have.property('connect_timeout', 5000);
		});

		it('should throw error if queue name is missing', function() {
			expect(dq).to.throw(Error);
		});

		it('should return an instance of event emitter', function() {
			expect(queue).to.be.instanceof(EventEmitter);
		});
	});

	describe('nextId', function() {
		it('should setup queue id and return it', function() {
			return expect(queue.nextId()).to.eventually.equal(1);
		});

		it('should increment queue id and return it', function() {
			queue.client.set('dq:test:id', 5);

			return expect(queue.nextId()).to.eventually.equal(6);
		});

		it('should reject if queue id is not number', function() {
			queue.client.hmset('dq:test:id', { a: 1 });

			return expect(queue.nextId()).to.eventually.be.rejected;
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
				, timeout: 120
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
				, timeout: 120
			};

			expect(function() { queue.fromClient(job) }).to.throw(Error);
		});
	});

	describe('add', function() {
		it('should add a new job to queue', function() {
			return queue.add({ a: 1 }).then(function() {
				queue.client.hgetall('dq:test:1', function(err, res) {
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
					queue.client.hgetall('dq:test:1', function(err, res) {
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
			queue.client.set('dq:test:work', 1);

			var spy = sinon.spy();
			queue.on('add error', spy);

			return expect(queue.add({ a: 1 })).to.eventually.be.rejectedWith(Error);
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

			return queue.add({ a: 1 }).then(function() {
				expect(queue.idle).to.be.true;
				expect(spy).to.have.been.calledThrice;
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
				expect(spy).to.have.been.calledThrice;
				expect(spy).to.have.been.calledWith(0);
			});
		});
	});

	describe('more test', function() {
		it('should do more test', function() {

		});
	});
});
