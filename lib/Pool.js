'use strict'

const EventEmitter = require('events').EventEmitter

const factoryValidator = require('./factoryValidator')
const PoolOptions = require('./PoolOptions')
const PriorityQueue = require('./PriorityQueue')
const ResourceRequest = require('./ResourceRequest')
const ResourceLoan = require('./ResourceLoan')
const PooledResource = require('./PooledResource')

/**
 * TODO: move me
 */
const FACTORY_CREATE_ERROR = 'factoryCreateError'
const FACTORY_DESTROY_ERROR = 'factoryDestroyError'

class Pool extends EventEmitter {

  /**
   * Generate an Object pool with a specified `factory` and `config`.
   *
   * @param {Object} factory
   *   Factory to be used for generating and destroying the items.
   * @param {Function} factory.create
   *   Should create the item to be acquired,
   *   and call it's first callback argument with the generated item as it's argument.
   * @param {Function} factory.destroy
   *   Should gently close any resources that the item is using.
   *   Called before the items is destroyed.
   * @param {Function} factory.validate
   *   Test if a resource is still valid .Should return a promise that resolves to a boolean, true if resource is still valid and false
   *   If it should be removed from pool.
   */
  constructor (factory, options) {
    super()

    factoryValidator(factory)

    this._config = new PoolOptions(options)

    // TODO: fix up this ugly glue-ing
    this._Promise = this._config.Promise

    this._factory = factory
    this._draining = false
    this._started = false
    /**
     * Holds waiting clients
     * @type {PriorityQueue}
     */
    this._waitingClientsQueue = new PriorityQueue(this._config.priorityRange)

    /**
     * Collection of promises for resource creation calls made by the pool to factory.create
     * @type {Set}
     */
    this._factoryCreateOperations = new Set()

    /**
     * Collection of promises for resource destruction calls made by the pool to factory.destroy
     * @type {Set}
     */
    this._factoryDestroyOperations = new Set()

    /**
     * A queue/stack of pooledResources awaiting acquisition
     * TODO: replace with LinkedList backed array
     * @type {Array}
     */
    this._availableObjects = []

    /**
     * Collection of references for any resource that are undergoing validation before being acquired
     * @type {Set}
     */
    this._testOnBorrowResources = new Set()

    /**
     * Collection of references for any resource that are undergoing validation before being returned
     * @type {Set}
     */
    this._testOnReturnResources = new Set()

    /**
     * Collection of promises for any validations currently in process
     * @type {Set}
     */
    this._validationOperations = new Set()

    /**
     * All objects associated with this pool in any state (except destroyed)
     * @type {PooledResourceCollection}
     */
    this._allObjects = new Set()

    /**
     * Loans keyed by the borrowed resource
     * @type {Map}
     */
    this._resourceLoans = new Map()

    this._removeIdleTimer = null
    this._removeIdleScheduled = false

    // create initial resources (if factory.min > 0)
    if (this._config.autostart === true) {
      this.start()
    }
  }

  _destroy (pooledResource) {
    // FIXME: do we need another state for "in destruction"?
    pooledResource.invalidate()
    this._allObjects.delete(pooledResource)
    // NOTE: this maybe very bad promise usage?
    const destroyPromise = this._factory.destroy(pooledResource.obj)
    const wrappedDestroyPromise = this._Promise.resolve(destroyPromise)
    this._factoryDestroyOperations.add(wrappedDestroyPromise)

    wrappedDestroyPromise
    .catch((reason) => {
      this.emit(FACTORY_DESTROY_ERROR, reason)
    })
    .then(() => {
      this._factoryDestroyOperations.delete(wrappedDestroyPromise)
    })

    // TODO: maybe ensuring minimum pool size should live outside here
    this._ensureMinimum()
  }

  /**
   * Checks and removes the available (idle) resources that have timed out.
   * @private
   */
  _removeIdle () {
    const toRemove = []
    const now = Date.now()

    this._removeIdleScheduled = false

    // Go through the available (idle) items,
    // check if they have timed out
    for (let i = 0, al = this._availableObjects.length; i < al && (this._config.refreshIdle && (this._count - this._config.min > toRemove.length)); i += 1) {
      const idletime = now - this._availableObjects[i].lastReturnTime
      if (idletime >= this._config.idleTimeoutMillis) {
        // Client timed out, so destroy it.
        toRemove.push(this._availableObjects[i].obj)
      }
    }

    for (let j = 0, tr = toRemove.length; j < tr; j += 1) {
      this._destroy(toRemove[j])
    }

    // Replace the available items with the ones to keep.
    const al = this._availableObjects.length

    if (al > 0) {
      this._scheduleRemoveIdle()
    }
  }

  /**
   * Schedule removal of idle items in the pool.
   *
   * More schedules cannot run concurrently.
   */
  _scheduleRemoveIdle () {
    if (!this._removeIdleScheduled) {
      this._removeIdleScheduled = true
      this._removeIdleTimer = setTimeout(() => this._removeIdle(), this._config.reapInterval)
    }
  }

  /**
   * Attempt to move an available resource into test and then onto a waiting client
   * @return {Boolean} could we move an available resource into test
   */
  _testOnBorrow () {
    if (this._availableObjects.length < 1) {
      return false
    }

    const pooledResource = this._availableObjects.shift()
    // Mark the resource as in test
    pooledResource.test()
    this._testOnBorrowResources.add(pooledResource)
    const validationPromise = this._factory.validate(pooledResource.obj)
    const wrappedValidationPromise = this._Promise.resolve(validationPromise)
    this._validationOperations.add(wrappedValidationPromise)

    wrappedValidationPromise.then((isValid) => {
      this._validationOperations.delete(wrappedValidationPromise)
      this._testOnBorrowResources.delete(pooledResource)

      if (isValid === false) {
        pooledResource.invalidate()
        this._destroy(pooledResource)
        this._dispense()
        return
      }
      this._dispatchPooledResourceToNextWaitingClient(pooledResource)
    })

    return true
  }

  /**
   * Attempt to move an available resource to a waiting client
   * @return {Boolean} [description]
   */
  _dispatchResource () {
    if (this._availableObjects.length < 1) {
      return false
    }

    const pooledResource = this._availableObjects.shift()
    this._dispatchPooledResourceToNextWaitingClient(pooledResource)
    return
  }

  /**
   * Attempt to resolve an outstanding resource request using an available resource from
   * the pool.
   * Shuffles things through
   * TODO: rename this!
   *
   * @private
   */
  _dispense () {
    // console.log('_dispense called')

    /**
     * Local variables for ease of reading/writing
     * these don't (shouldn't) change across the execution of this fn
     */
    const numWaitingClients = this._waitingClientsQueue.length

    // If there aren't any waiting requests then there is nothing to do
    if (numWaitingClients < 1) {
      // console.log('dispense bailing - no waiting requests')
      return
    }

    // If we are doing test-on-borrow see how many more resources need to be moved into test
    // to help satisfy waitingClients
    if (this._config.testOnBorrow === true) {
      // console.log('dispense - entering test-on-borrow branch')
      // Could all the outstanding clients be fulfilled by resources under going test-on-borrow
      if (numWaitingClients <= this._testOnBorrowResources.size) {
        // console.log('dispense bailing - all waiting requests could be fulfilled by resources in test-on-borrow')
        return
      }
      // how many available resources do we need to shift into test
      const desiredNumberOfResourcesToMoveIntoTest = numWaitingClients - this._testOnBorrowResources.size
      const actualNumberOfResourcesToMoveIntoTest = Math.min(this._availableObjects.length, desiredNumberOfResourcesToMoveIntoTest)
      for (let i = 0; actualNumberOfResourcesToMoveIntoTest > i; i++) {
        this._testOnBorrow()
      }
      // console.log('dispense - leaving test-on-borrow branch')
    }

    // Do we still have outstanding requests that can't be fulfilled by resources in-test and available
    const potentiallyAllocableResources = this._availableObjects.length +
      this._testOnBorrowResources.size +
      this._testOnReturnResources.size +
      this._factoryCreateOperations.size

    const resourceShortfall = numWaitingClients - potentiallyAllocableResources

    if (resourceShortfall > 0) {
      // console.log('dispense - entering resource shortfall branch')
      const spareResourceCapacity = this._config.max - (this._allObjects.size + this._factoryCreateOperations.size)

      if (spareResourceCapacity < 1) {
        // console.log('not enough allocable resources to satisfy all waiting clients and at max capacity')
      }

      const actualNumberOfResourcesToCreate = Math.min(spareResourceCapacity, resourceShortfall)
      for (let i = 0; actualNumberOfResourcesToCreate > i; i++) {
        this._createResource()
      }
      // console.log('dispense - leaving resource shortfall branch')
    }

    // if we aren't testing-on-borrow then lets try to allocate what we can
    if (this._config.testOnBorrow === false) {
      // console.log('dispense - entering non test-on-borrow branch')
      const actualNumberOfResourcesToDispatch = Math.min(this._availableObjects.length, numWaitingClients)
      for (let i = 0; actualNumberOfResourcesToDispatch > i; i++) {
        this._dispatchResource()
      }
      // console.log('dispense - leaving non test-on-borrow branch')
    }
    // console.log('dispense finished')
  }

  /**
   * Dispatches a pooledResource to the next waiting client (if any) else
   * puts the PooledResource back on the available list
   * @param  {[type]} pooledResource [description]
   * @return {[type]}                [description]
   */
  _dispatchPooledResourceToNextWaitingClient (pooledResource) {
    const clientResourceRequest = this._waitingClientsQueue.dequeue()
    if (clientResourceRequest === undefined) {
      // While we were away either all the waiting clients timed out
      // or were somehow fulfilled. put our pooledResource back.
      pooledResource.idle()
      this._addPooledResourceToAvailableObjects(pooledResource)
      // TODO: do need to trigger anything before we leave?
      return false
    }
    const loan = new ResourceLoan(pooledResource)
    this._resourceLoans.set(pooledResource.obj, loan)
    pooledResource.allocate()
    clientResourceRequest.resolve(pooledResource.obj)
    return true
  }

  /**
   * @private
   */
  _createResource () {
    // An attempt to create a resource
    const factoryPromise = this._factory.create()
    const wrappedFactoryPromise = this._Promise.resolve(factoryPromise)
    this._factoryCreateOperations.add(wrappedFactoryPromise)

    wrappedFactoryPromise
    .then((resource) => {
      this._factoryCreateOperations.delete(wrappedFactoryPromise)
      this._handleNewResource(resource)
    })
    .catch((reason) => {
      this._factoryCreateOperations.delete(wrappedFactoryPromise)
      this.emit(FACTORY_CREATE_ERROR, reason)
      this._dispense()
    })
    .then()
  }

  _handleNewResource (resource) {
    const pooledResource = new PooledResource(resource)
    this._allObjects.add(pooledResource)
    // TODO: check we aren't exceding our maxPoolSize before doing
    this._dispatchPooledResourceToNextWaitingClient(pooledResource)
  }

  /**
   * @private
   */
  _ensureMinimum () {
    if (this._draining === true) {
      return
    }
    if (this._count < this._config.min) {
      const diff = this._config.min - this._count
      for (let i = 0; i < diff; i++) {
        this._createResource()
      }
    }
  }

  start () {
    if (this._draining === true) {
      return
    }
    if (this._started === true) {
      return
    }
    this._started = true
    this._ensureMinimum()
  }

  /**
   * Request a new resource. The callback will be called,
   * when a new resource is available, passing the resource to the callback.
   * TODO: should we add a seperate "acquireWithPriority" function
   *
   * @param {Function} callback
   *   Callback function to be called after the acquire is successful.
   *   If there is an error preventing the acquisition of resource, an error will
   *   be the first parameter, else it will be null.
   *   The acquired resource will be the second parameter.
   *
   * @param {Number} priority
   *   Optional.  Integer between 0 and (priorityRange - 1).  Specifies the priority
   *   of the caller if there are no available resources.  Lower numbers mean higher
   *   priority.
   *
   * @returns {Promise}
   */
  acquire (priority) {
    if (this._draining) {
      return this._Promise.reject(new Error('pool is draining and cannot accept work'))
    }

    // TODO: should we defer this check till after this event loop incase "the situation" changes in the meantime
    if (this._config.maxWaitingClients !== undefined && this._waitingClientsQueue.length >= this._config.maxWaitingClients) {
      return this._Promise.reject(new Error('max waitingClients count exceeded'))
    }

    const resourceRequest = new ResourceRequest(this._config.acquireTimeoutMillis)
    this._waitingClientsQueue.enqueue(resourceRequest, priority)
    this._dispense()

    return resourceRequest.promise
  }

  /**
   * Return the resource to the pool when it is no longer required.
   *
   * @param {Object} obj
   *   The acquired object to be put back to the pool.
   */
  release (resource) {
    // check for an outstanding loan
    const loan = this._resourceLoans.get(resource)

    if (loan === undefined) {
      return this._Promise.reject(new Error('Resource not currently part of this pool'))
    }

    this._resourceLoans.delete(resource)
    loan.resolve()
    const pooledResource = loan.pooledResource

    pooledResource.deallocate()
    this._addPooledResourceToAvailableObjects(pooledResource)

    this._scheduleRemoveIdle()
    this._dispense()
    return this._Promise.resolve()
  }

  /**
   * Request the resource to be destroyed. The factory's destroy handler
   * will also be called.
   *
   * This should be called within an acquire() block as an alternative to release().
   *
   * @param {Object} resource
   *   The acquired resource to be destoyed.
   */
  destroy (resource) {
    // check for an outstanding loan
    const loan = this._resourceLoans.get(resource)

    if (loan === undefined) {
      return this._Promise.reject(new Error('Resource not currently part of this pool'))
    }

    this._resourceLoans.delete(resource)
    loan.resolve()
    const pooledResource = loan.pooledResource

    pooledResource.deallocate()
    this._destroy(pooledResource)
    return this._Promise.resolve()
  }

  // FIXME: replace _availableObjects with a queue/stack impl that both have same interface
  _addPooledResourceToAvailableObjects (pooledResource) {
    if (this._config.fifo === true) {
      this._availableObjects.push(pooledResource)
    } else {
      this._availableObjects.splice(0, 0, pooledResource)
    }
  }

  /**
   * Disallow any new acquire calls and let the request backlog dissapate.
   * Resolves once all resources are returned to pool and available...
   * @returns {Promise}
   */
  drain () {
    // disable the ability to put more work on the queue.
    this._draining = true
    return this.__allResourceRequestsSettled()
      .then(() => {
        return this.__allResourcesReturned()
      })
  }

  __allResourceRequestsSettled () {
    if (this._waitingClientsQueue.length > 0) {
      // wait for last waiting client to be settled
      // FIXME: what if they can "resolve" out of order....?
      return this._waitingClientsQueue.tail.promise.then(() => {}, () => {})
    }
    return this._Promise.resolve()
  }

  // FIXME: this is a horrific mess
  __allResourcesReturned () {
    const ps = []
    this._resourceLoans.forEach(function (loan) {
      ps.push(loan.promise)
    })
    return this._Promise.all(ps)
  }

  /**
   * Forcibly destroys all available resources regardless of timeout.  Intended to be
   * invoked as part of a drain.  Does not prevent the creation of new
   * resources as a result of subsequent calls to acquire.
   *
   * Note that if factory.min > 0, the pool will destroy all idle resources
   * in the pool, but replace them with newly created resources up to the
   * specified factory.min value.  If this is not desired, set factory.min
   * to zero before calling clear()
   *
   */
  clear () {
    this._removeIdleScheduled = false
    clearTimeout(this._removeIdleTimer)
    this._availableObjects.forEach(this._destroy, this)
    return this._Promise.all(this._factoryDestroyOperations)
  }

  /**
   * Decorates a function to use an acquired resource from the object pool when called.
   *
   * @param {Function} decorated
   *   The decorated function, accepting a resource as the first argument and
   *   (optionally) a callback as the final argument.
   *
   * @param {Number} priority
   *   Optional.  Integer between 0 and (priorityRange - 1).  Specifies the priority
   *   of the caller if there are no available resources.  Lower numbers mean higher
   *   priority.
   */
  pooled (decorated, priority) {
    const self = this
    return function () {
      const callerArgs = arguments
      const callerCallback = callerArgs[callerArgs.length - 1]
      const callerHasCallback = typeof callerCallback === 'function'

      self.acquire(priority)
      .then(_onAcquire)
      .catch(function (err) {
        if (callerHasCallback) {
          callerCallback(err)
        }
      })

      function _onAcquire (resource) {
        function _wrappedCallback () {
          self.release(resource)
          if (callerHasCallback) {
            callerCallback.apply(null, arguments)
          }
        }

        const args = [resource].concat(Array.prototype.slice.call(callerArgs, 0, callerHasCallback ? -1 : undefined))
        args.push(_wrappedCallback)

        decorated.apply(null, args)
      }
    }
  }

  /**
   * The combined count of the currently created objects and those in the
   * process of being created
   * Does NOT include resources in the process of being destroyed
   * sort of legacy...
   * @return {Number}
   */
  get _count () {
    return this._allObjects.size + this._factoryCreateOperations.size
  }

  /**
   * see _count above
   * @return {Number} [description]
   */
  get size () {
    return this._count
  }

  /**
   * number of available resources
   * @return {Number} [description]
   */
  get available () {
    return this._availableObjects.length
  }

  /**
   * number of resources that are currently acquired
   * @return {[type]} [description]
   */
  get borrowed () {
    return this._resourceLoans.size
  }

  /**
   * number of waiting acquire calls
   * @return {[type]} [description]
   */
  get pending () {
    return this._waitingClientsQueue.length
  }

  /**
   * maximum size of the pool
   * @return {[type]} [description]
   */
  get max () {
    return this._config.max
  }

  /**
   * minimum size of the pool
   * @return {[type]} [description]
   */
  get min () {
    return this._config.min
  }
}

module.exports = Pool
