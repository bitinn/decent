
// test tools
var chai = require('chai');
var sinon = require('sinon');
var cap = require('chai-as-promised');
var sc = require('sinon-chai');
chai.use(cap);
chai.use(sc);

var expect = chai.expect;

// test subjects
var dq = require('../index.js');
var EventEmitter = require('events').EventEmitter;
var Redis = require('redis');

var queue, spy;

describe('dq', function() {
	describe('constructor', function() {
		it('should return a dq instance properly', function() {
			queue = dq('test');

			expect(queue.name).to.equal('test');
			expect(queue.port).to.equal(6379);
			expect(queue.host).to.equal('127.0.0.1');
		});

		it('should allow custom redis options', function() {
			queue = dq('test', { enable_offline_queue: false });

			expect(queue.opts).to.be.an('object');
			expect(queue.opts).to.have.property('enable_offline_queue', false);
		});

		it('should throw error if name is missing', function() {
			expect(dq).to.throw(Error);
		});

		it('should be an instance of event emitter', function() {
			queue = dq('test');

			expect(queue).to.be.instanceof(EventEmitter);
		});
	});

	describe('more test', function() {
		it('should do more test', function() {

		});
	});
});
