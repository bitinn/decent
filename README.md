
decent
======

Job queue is hard, so we make it decent for you.

`decent` is a Redis-based job queue for Node.

[![npm version](https://badge.fury.io/js/decent.svg)](http://badge.fury.io/js/decent) [![Build Status](https://travis-ci.org/bitinn/decent.svg?branch=master)](https://travis-ci.org/bitinn/decent) [![Coverage Status](https://img.shields.io/coveralls/bitinn/decent.svg)](https://coveralls.io/r/bitinn/decent)


# Motivation

Despite efforts from brilliant developers, a reliable job queue using node.js and redis is still somewhat of a mythical beast. And no wonder: redis isn't a queueing system by nature and node.js isn't known for superior error handling; add concurrency into the mix and you got a leaky pipeline that's almost impossible to debug.

In short, we need better groundwork before we can harness the power of queue. Hence the birth of `decent`: we want a library that provides solid building blocks for complex pipelines, so we can safely enjoy what job queue has to offer.


# Features

- Simple API and helpers, powered by `Promise`.
- Proper code coverage is a basic requirement, on average at least 3 test cases for each API, and we put extra emphasis on negative tests, because that's where most queue fall and cause headaches.
- Annotated source code, less than 1,000 loc in total.
- No dependency besides `redis` driver, make use of native promise whenever possible, fallback to `bluebird` for older Node release.
- Rich event to aid automation, monitoring and building larger pipeline.


# Install

`npm install decent --save`


# API


## decent(name, opts)

Create a queue with `name` and config redis client connection based on `opts`, returns a decent queue instance.

### examples

```
var decent = require('decent');

var q1 = decent('test');
var q2 = decent('test', { port: 6379, host: 'localhost', connect_timeout: 5000 });
```

### opts

- `port`: redis server port, default to `6379`
- `host`: redis server host, default to `'127.0.0.1'`
- `blockTimeout`: how long should client wait for next job (see redis document on blocking command, such as [BLPOP](http://redis.io/commands/BLPOP)), defaults to `30` seconds, `0` to block forever.
- `maxRetry`: how many retries a job can have before moving to failure queue, defaults to `3`, `0` to disable retry.
- and all [redis client options](https://github.com/mranney/node_redis#rediscreateclient).


## queue.add(data, opts)

Create a job on queue using `data` as payload and allows job specific `opts`, returns a promise that resolve to the created job.

### examples

```
queue.add({ a: 1 }).then(function(job) {
	console.log(job.data); // { a: 1 }
});

queue.add({ a: 1, b: 1 }, { retry: 1, timeout: 120 }).then(function(job) {
	console.log(job); // { a: 1, b: 1 }
});
```

### opts

- `retry`: default to `0`
- `timeout`: default to `60` seconds

### job

- `id`: job id
- `data`: payload
- `retry`: retry count
- `timeout`: worker timeout (not currently used)


## queue.worker(handler)

Register a handler function that process jobs, and start processing items in queue.

### examples

```
queue.worker(function(job) {
	console.log(job);
});
```


## queue.count(name)

Returns a promise that resolve to the queue length of specified queue, default to `work` queue.

### examples

```
queue.count('work').then(function(count) {
	console.log(count); // pending jobs
});

queue.count('run').then(function(count) {
	console.log(count); // running jobs
});

queue.count('fail').then(function(count) {
	console.log(count); // failed jobs
});
```


## queue.get(id)

Returns a promise that resolve to the job itself.

### examples

```
queue.get(1).then(function(job) {
	console.log(job.id); // 1
});
```


# Events

`decent` is also an instance of `EventEmitter`, so you can use `queue.on('event', func)` to listen for events as usual.

## redis client related

- `queue.emit('client ready')`: client is ready. (redis client has buffer built-in, so this event is emitted as soon as redis client is started)
- `queue.emit('client error', err)`: client connection error.
- `queue.emit('client close')`: client connection has been closed.
- `queue.emit('client pressure', number)`: pending number of commands to run on server, useful for rate limiting.

## queue worker related

- `queue.emit('queue ok', job)`: queue worker has processed a `job`.
- `queue.emit('queue error', err)`: queue worker has failed to processed a job and thrown `err`.
- `queue.emit('queue exit', err)`: queue has terminated due to `err`.
- `queue.emit('queue stop')`: queue has stopped gracefully.

## queue client related

- `queue.emit('add ok', job)`: `job` has been added to queue.
- `queue.emit('add error', err)`: failed to add job onto queue due to `err`.


# Development

```
npm install
npm test
```

# Future plan

- API for handling failed jobs
- Use-case examples
- Web UI

# License

MIT

