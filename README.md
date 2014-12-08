
decent
======

[![npm version](https://badge.fury.io/js/decent.svg)](http://badge.fury.io/js/decent) [![Build Status](https://travis-ci.org/bitinn/decent.svg?branch=master)](https://travis-ci.org/bitinn/decent) [![Coverage Status](https://img.shields.io/coveralls/bitinn/decent.svg)](https://coveralls.io/r/bitinn/decent) [![Dependency Status](https://david-dm.org/bitinn/decent.svg)](https://david-dm.org/bitinn/decent)

`decent` is a Redis-based job queue for Node.

*Job queue is hard to manage, we make it decent for you.*


# Motivation

Despite efforts from brilliant developers, a reliable job queue using node.js and redis is still somewhat of a mythical beast. And no wonder: redis isn't a queueing solution by itself and node.js isn't known for superior error handling; add concurrency into the mix and you got a leaky pipeline that's almost impossible to debug.

In short, we need better groundwork before we can harness the power of queue. Hence the birth of `decent`: we want a library that provides solid building blocks for complex pipelines, so we can safely enjoy what job queue has to offer.


# Features

- **Simple API**, powered by `Promise`, works in harmony with your generator library.
- **Proper code coverage**, we put extra emphasis on negative tests, because that's when most queues fall apart and cause headaches.
- **Annotated source code**, less than 700 loc in total.
- No dependency besides `redis` driver, make use of native promise whenever possible, fallback to `bluebird` for older Node release.
- Rich events to aid automation, status monitoring or building larger pipeline.


# Install

`npm install decent --save`


# API


## decent(name, opts)

Create a queue with `name` and config redis client connection based on `opts`, returns a decent queue instance.

### examples

```
var decent = require('decent');

var queue1 = decent('q1');
var queue2 = decent('q2', { 
	port: 6379
	, host: 'localhost'
	, connect_timeout: 5000 
});
```

### opts

- `port`: redis server port, default to `6379`
- `host`: redis server host, default to `'127.0.0.1'`
- `blockTimeout`: how long a client should wait for next job (see redis document on blocking command, such as [BLPOP](http://redis.io/commands/BLPOP)), defaults to `30` seconds, `0` to block forever.
- `maxRetry`: how many retries a job can have before being moved to failure queue, defaults to `3`, `0` to disable retry.
- and all [redis client options](https://github.com/mranney/node_redis#rediscreateclient).


## queue.add(data, opts)

Create a job on queue using `data` as payload and allows job specific `opts`, returns a promise that resolve to the created job.

### examples

```
queue.add({ a: 1 }).then(function(job) {
	console.log(job.data); // { a: 1 }
});

queue.add({ a: 1, b: 1 }, { retry: 1, timeout: 120 }).then(function(job) {
	console.log(job.data); // { a: 1, b: 1 }
});
```

### opts

- `retry`: set initial retry counter, default to `0`
- `timeout`: set worker timeout in seconds, default to `60`

### job

- `id`: job id
- `data`: payload
- `retry`: current retry count for this job
- `timeout`: how many seconds a worker can run before it's terminated.


## queue.worker(handler)

Register a handler function that process jobs, and start processing jobs in queue.

### examples

```
queue.worker(function(job, done) {

	// ... do actual work

	done();
});
```

### done(err);

Must be called to signal the completion of job processing.

If called with an instance of `Error`, then `decent` will assume worker failed to process this job.

Fail jobs are moved back to work queue when they are below retry threshold, otherwise they are moved to failure queue.


## queue.count(name)

Returns a promise that resolve to the queue length of specified queue, default to `work` queue.

### examples

```
queue.count('work').then(function(count) {
	console.log(count); // pending job count
});

queue.count('run').then(function(count) {
	console.log(count); // running job count
});

queue.count('fail').then(function(count) {
	console.log(count); // failed job count
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


## queue.remove(id)

Returns a promise that will resolve when job is removed from redis (both job data and job queue).

### examples

```
queue.remove(1).then(function() {
	// ...
});
```


## queue.stop()

Instructs queue worker to terminate gracefully on next loop. See events on how to monitor queue.

### examples

```
queue.stop();
```


## queue.restart()

Restarts the queue worker loop. See events on how to monitor queue.

### examples

```
queue.restart();
```


# Events

`decent` is an instance of `EventEmitter`, so you can use `queue.on('event', func)` as usual.

## Redis client related

- `queue.emit('client ready')`: client is ready. (redis client has buffer built-in, so this event is emitted as soon as redis client is started.)
- `queue.emit('client error', err)`: client connection experiences error.
- `queue.emit('client close')`: client connection has been closed.
- `queue.emit('client pressure', number)`: pending number of commands, useful for rate limiting.

## queue worker related

- `queue.emit('queue start')`: queue loop has started.
- `queue.emit('queue ok', job)`: queue worker has processed a `job`.
- `queue.emit('queue error', err)`: queue worker has failed to processed a job and thrown `err` (caught properly, so queue does not exit)
- `queue.emit('queue exit', err)`: queue loop has terminated due to `err`.
- `queue.emit('queue stop')`: queue loop has stopped gracefully.

## queue client related

- `queue.emit('add ok', job)`: `job` has been added to queue.
- `queue.emit('add error', err)`: failed to add job onto queue due to `err`.


# Development

```
npm install
npm test
```

Feel feel to raise any issues or feature requests, note that we do intend to keep this API simple, and all changes must be well-tested.


# Future plan

- API for re-queueing failed jobs
- Use-case examples
- Web UI


# License

MIT

