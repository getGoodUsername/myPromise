/**
 * This is a crude rendition of the actual ECMA script
 * defined Promise constructor, and I expect there to
 * be differences between the two, but this is just so
 * I can understand better what is going on
 */
function isThenable(obj)
{
    return typeof obj?.then === 'function'
     && obj.then.length >= 1;
}

function flattenThenable(input, resolveArg, rejectArg)
{
    /**
      * thenable input is used to control the resolve and
      * rejection of a MyPromise object; works because
      * an instance of a MyPromise obj contains their
      * own #resolve and #reject arrow functions, which
      * obviously will always have the correct this.
      */
    try
    {
        input.then(
            (successVal) => resolveArg(successVal),
            (errorVal) => rejectArg(errorVal),
        );
    }
    catch (errorVal)
    {
        /**
          * TODO: handle the case when always a thenable
          * object and causes a stack overflow by somehow
          * re-throwing the exception
          */
        rejectArg(errorVal);
    }
}

class MyPromise
{
    constructor(executor)
    {
        try
        {
            executor(this.#resolve, this.#reject);
        }
        catch (errorVal)
        {
            /**
              * allow reject and throw in executor to
              * have the same behavior (real promise works
              * like this too.) */
            this.#reject(errorVal);
        }
    }

    then(onSuccessArg, onFailureArg)
    {
        /**
          * Having the default arrow functions for onSuccess and
          * onFailure not only ensures that the getExecutor func
          * is always passed a callable consumerFn, but in addition
          * it allows for successVal and errorVal to bubble through
          * to the next Promise if they are not caught with the
          * current .then or .catch
          */
        const onSuccess = (typeof onSuccessArg === 'function') ? onSuccessArg : (successVal) => successVal;
        const onFailure = (typeof onFailureArg === 'function') ? onFailureArg : (errorVal) => { throw errorVal; };

        const getExecutor = (consumerFn) => (resolveArg, rejectArg) =>
        {
            try { resolveArg(consumerFn(this.#result)); }
            catch (errorVal) { rejectArg(errorVal); }
        };

        switch (this.#state)
        {
            case MyPromise.#States.pending:
            {
                /**
                  * The result of the current promise is not available yet,
                  * make sure to only execute onSuccess or onFailure once
                  * the result is ready, (aka when this resolve/reject get called)
                  * but also make sure to be able to resolve/reject
                  * the nextPromise in the chain. Please note that every
                  * callbackfn (executor) passed to the MyPromise constructor
                  * gets their own "bound" version of this.#resolve/#reject
                  * and thats the only reason that this can work.
                  */

                /* do nothing in executor */
                const nextPromise = new MyPromise(() => {});
                this.#consumingFunctionQueueFor
                    .resolve
                    .push(() => getExecutor(onSuccess)(nextPromise.#resolve, nextPromise.#reject));
                this.#consumingFunctionQueueFor
                    .reject
                    .push(() => getExecutor(onFailure)(nextPromise.#resolve, nextPromise.#reject));
                return nextPromise;
            }
            case MyPromise.#States.fulfilled:
            {
                return new MyPromise(getExecutor(onSuccess));
            }
            case MyPromise.#States.rejected:
            {
                return new MyPromise(getExecutor(onFailure));
            }
            default:
                throw Error("Don't know how got to this code path!");
        }
    }

    catch(onFailure)
    {
        return this.then(null, onFailure);
    }

    finally(callbackfn)
    {
        const onSuccess = (successVal) =>
        {
            if (typeof callbackfn === 'function') callbackfn();
            /**
              * do nothing with what will be this.#result
              * and just pass to the next promise
              */
            return successVal;
        };

        const onFailure = (errorVal) =>
        {
            if (typeof callbackfn === 'function') callbackfn();
            throw errorVal;
        };

        return this.then(onSuccess, onFailure);
    }

    #result = undefined;
    #state = MyPromise.#States.pending;
    #resolveOrRejectHasBeenExecuted = false;
    #consumingFunctionQueueFor = { resolve: [], reject: [] };

    /**
      * Note for both #resolve and #reject
      * this.#result MUST be set before executing
      * their respective consumingFunctionQueues
      * since each function call is a closure with .then's
      * getExecutor function that returns another closure
      * that uses this.#result.
      */
    #resolve = (successVal) =>
    {
        if (isThenable(successVal))
        {
            flattenThenable(successVal, this.#resolve, this.#reject);
            return;
        }

        if (this.#resolveOrRejectHasBeenExecuted) return;

        this.#resolveOrRejectHasBeenExecuted = true;
        setTimeout(() =>
        {
            this.#result = successVal;
            this.#state = MyPromise.#States.fulfilled;
            this.#consumingFunctionQueueFor.resolve.forEach((func) => func());
            this.#cleanUpAfterResolvingOrRejecting();
        }, 0);
    };

    #reject = (errorVal) =>
    {
        if (isThenable(errorVal))
        {
            flattenThenable(errorVal, this.#resolve, this.#reject);
            return;
        }

        if (this.#resolveOrRejectHasBeenExecuted) return;

        this.#resolveOrRejectHasBeenExecuted = true;
        setTimeout(() =>
        {
            this.#result = errorVal;
            this.#state = MyPromise.#States.rejected;
            this.#consumingFunctionQueueFor.reject.forEach((func) => func());
            this.#cleanUpAfterResolvingOrRejecting();
        }, 0);
    };

    #cleanUpAfterResolvingOrRejecting()
    {
        /**
          * Any of the functions stored in their respective
          * resolve or reject arrays will not be used, since
          * that code path is no longer reachable, but since
          * the created MyPromise object will continue to technically
          * have access to them, there is a significant chance that due
          * to this the garbage collector may avoid freeing the memory
          * associated with it until the MyPromise object gets freed. Since
          * I can't delete private props, this is the next best thing
          * to try to remedy the problem.
          */
        this.#consumingFunctionQueueFor = null;
    }

    static #States = Object.freeze({
        pending: 'pending',
        fulfilled: 'fulfilled',
        rejected: 'rejected',
    });

    static all(promiseCollection)
    {
        const promiseArray = Array.isArray(promiseCollection)
            ? promiseCollection : [...promiseCollection];
        const returningPromise = new MyPromise(() => {});
        const resolveResults = new Array(promiseArray.length);
        let resolvedPromiseCount = 0;

        promiseArray
            .forEach((promise, index) =>
            {
                if (!(promise instanceof MyPromise || promise instanceof Promise))
                {
                    /** 'promise' arg is not an actual promise, just pass on the value. */
                    resolveResults[index] = promise;
                    return;
                }
                promise.then(
                    (successVal) =>
                    {
                        resolvedPromiseCount += 1;
                        resolveResults[index] = successVal;
                        if (resolvedPromiseCount === promiseArray.length)
                        {
                            returningPromise.#resolve(resolveResults);
                        }
                    },
                    (errorVal) => { returningPromise.#reject(errorVal); },
                );
            });

        return returningPromise;
    }

    static allSettled(promiseCollection)
    {
        /**
          * used polyfill example to make this implementation
          * polyfill from https://javascript.info/promise-api
          */
        const rejectHandler = (reason) => ({ status: 'rejected', reason });
        const resolveHandler = (value) => ({ status: 'fulfilled', value });
        const promiseArray = Array.isArray(promiseCollection)
            ? promiseCollection : [...promiseCollection];
        const convertedPromises = promiseArray
            .map((promise) => MyPromise.resolve(promise).then(resolveHandler, rejectHandler));

        return Promise.all(convertedPromises);
    }

    static resolve(input)
    {
        if (input instanceof MyPromise || input instanceof Promise) return input;
        return new MyPromise((resolve) => resolve(input));
    }

    static reject(input)
    {
        if (input instanceof MyPromise || input instanceof Promise) return input;
        return new MyPromise((resolve, reject) => reject(input));
    }
}

/**
 * resolve does not stop execution of the "executor"
 * func, if you really want to do that you need to
 * return!!!
 * *********************** CODE ***********************
 * new Promise(
 *      (resolve, reject) =>
 *      {
 *          resolve(42);
 *          for (let i = 0; i < 1e9; ++i) {}
 *      }
 * ).then(val => console.log("finally done!!!", val));
obj.forEach(val => console.log(val))
*/

/**
 * An actual call to resolve or reject will not
 * block the next instruction, which makes me
 * think that it maybe done concurrently....
 *
 * const test = new Promise((resolve, reject) =>
 * {
 *     console.log("executor is starting...")
 *     setTimeout(() =>
 *     {
 *         resolve("a word that is spelled correctly")
 *         console.log("just resolved!");
 *     }, 1000);
 *     console.log("executor function is finishing...");
 * });
 *
 * const prom = test.then(val =>
 * {
 *     console.log("second executor is starting...")
 *     setTimeout(() => console.log("invoked later?"), 2000)
 *     console.log('about to resolve (terminating then callback)')
 * });
 *
 * *************************** OUTPUT ***************************
 * //At time 00s:
 * executor is starting...
 * executor function is finishing...
 *
 *
 * //At time 01s:
 * just resolved!
 * second executor is starting...
 * about to resolve (terminating then callback)
 *
 *
 * //At time 03s:
 * invoked later?
 */

{
    console.log('Using standard Promise, execution is:');
    const test = new Promise((resolve, reject) =>
    {
        console.log('executor is starting...');
        setTimeout(() =>
        {
            resolve('a word that is spelled correctly');
            console.log('just resolved!');
        }, 1000);
        console.log('executor function is finishing...');
    });

    const prom = test.then((val) =>
    {
        console.log('second executor is starting...');
        setTimeout(() => console.log('invoked later?'), 2000);
        console.log('about to resolve (terminating then callback)');
    });
}

// {
//     console.log('\n'.repeat(2));
//     console.log("Using MyPromises, execution is:");
//     const test = new Promise((resolve, reject) =>
//     {
//         console.log("executor is starting...")
//         setTimeout(() =>
//         {
//             resolve("a word that is spelled correctly")
//             console.log("just resolved!");
//         }, 1000);
//         console.log("executor function is finishing...");
//     });

//     const prom = test.then(val =>
//     {
//         console.log("second executor is starting...")
//         setTimeout(() => console.log("invoked later?"), 2000)
//         console.log('about to resolve (terminating then callback)')
//     });
// }

// Another old version of MyPromise (second ver to be deprecated)
// class MyPromise
// {
//     constructor(executor)
//     {
//         try
//         {
//             executor(this.#resolve, this.#reject);
//         }
//         catch (errorVal)
//         {
//             /**
//               * allow reject and throw in executor to
//               * have the same behavior (real promise works
//               * like this too.) */
//             this.#reject(errorVal);
//         }
//     }

//     then(onSuccessArg, onFailureArg)
//     {
//         /**
//           * Having the default arrow functions for onSuccess and
//           * onFailure not only ensures that the getExecutor func
//           * is always passed a callable consumerFn, but in addition
//           * it allows for successVal and errorVal to bubble through
//           * to the next Promise if they are not caught with the
//           * current .then or .catch
//           */
//         const onSuccess = (typeof onSuccessArg === 'function') ? onSuccessArg : (successVal) => successVal;
//         const onFailure = (typeof onFailureArg === 'function') ? onFailureArg : (errorVal) => { throw errorVal; };

//         const getExecutor = (consumerFn) => (resolveArg, rejectArg) =>
//         {
//             try
//             {
//                 const consumerFnResult = consumerFn(this.#result);
//                 const consumerFnResultIsThenable = typeof consumerFnResult?.then === 'function'
//                      && consumerFnResult.then.length >= 2;

//                 if (consumerFnResultIsThenable)
//                 {
//                     /**
//                       * The returned MyPromise/Promise object is used
//                       * to control when the nextPromise's resolve
//                       * or reject is executed, and due to the chaining,
//                       * all the other promises that come after it are also
//                       * subject to waiting for this resolve and reject to
//                       * be called
//                       */
//                     consumerFnResult.then(
//                         (successVal) => resolveArg(successVal),
//                         (errorVal) => rejectArg(errorVal),
//                     );
//                 }
//                 else resolveArg(consumerFnResult);
//             }
//             catch (errorVal)
//             {
//                 rejectArg(errorVal);
//             }
//         };

//         switch (this.#state)
//         {
//             case MyPromise.#States.pending:
//             {
//                 /**
//                   * The result of the current promise is not available yet,
//                   * make sure to only execute onSuccess or onFailure once
//                   * the result is ready, (aka when this resolve/reject get called)
//                   * but also make sure to be able to resolve/reject
//                   * the nextPromise in the chain. Please note that every
//                   * callbackfn (executor) passed to the MyPromise constructor
//                   * gets their own "bound" version of this.#resolve/#reject
//                   * and thats the only reason that this can work.
//                   */

//                 /* do nothing in executor */
//                 const nextPromise = new MyPromise(() => {});
//                 this.#consumingFunctionQueueFor
//                     .resolve
//                     .push(() => getExecutor(onSuccess)(nextPromise.#resolve, nextPromise.#reject));
//                 this.#consumingFunctionQueueFor
//                     .reject
//                     .push(() => getExecutor(onFailure)(nextPromise.#resolve, nextPromise.#reject));
//                 return nextPromise;
//             }
//             case MyPromise.#States.fulfilled:
//             {
//                 return new MyPromise(getExecutor(onSuccess));
//             }
//             case MyPromise.#States.rejected:
//             {
//                 return new MyPromise(getExecutor(onFailure));
//             }
//             default:
//                 throw Error("Don't know how got to this code path!");
//         }
//     }

//     catch(onFailure)
//     {
//         return this.then(null, onFailure);
//     }

//     finally(callbackfn)
//     {
//         const onSuccess = (successVal) =>
//         {
//             if (typeof callbackfn === 'function') callbackfn();
//             /* do nothing with what will be this.#result and just pass to the next promise */
//             return successVal;
//         };

//         const onFailure = (errorVal) =>
//         {
//             if (typeof callbackfn === 'function') callbackfn();
//             throw errorVal;
//         };

//         return this.then(onSuccess, onFailure);
//     }

//     static #States = Object.freeze({
//         pending: 'pending',
//         fulfilled: 'fulfilled',
//         rejected: 'rejected',
//     });

//     #result = undefined;
//     #state = MyPromise.#States.pending;
//     #resolveOrRejectHasBeenExecuted = false;
//     #consumingFunctionQueueFor = { resolve: [], reject: [] };

//     /**
//       * Note for both #resolve and #reject
//       * this.#result MUST be set before executing
//       * their respective consumingFunctionQueues
//       * since each function call is a closure with .then's
//       * getExecutor function that returns another closure
//       * that uses this.#result.
//       */
//     #resolve = (successVal) =>
//     {
//         if (this.#resolveOrRejectHasBeenExecuted) return;

//         this.#resolveOrRejectHasBeenExecuted = true;
//         setTimeout(() =>
//         {
//             this.#result = successVal;
//             this.#state = MyPromise.#States.fulfilled;
//             this.#consumingFunctionQueueFor.resolve.forEach((func) => func());
//             this.#cleanUpAfterResolvingOrRejecting();
//         }, 0);
//     };

//     #reject = (errorVal) =>
//     {
//         if (this.#resolveOrRejectHasBeenExecuted) return;

//         this.#resolveOrRejectHasBeenExecuted = true;
//         setTimeout(() =>
//         {
//             this.#result = errorVal;
//             this.#state = MyPromise.#States.rejected;
//             this.#consumingFunctionQueueFor.reject.forEach((func) => func());
//             this.#cleanUpAfterResolvingOrRejecting();
//         }, 0);
//     };

//     #cleanUpAfterResolvingOrRejecting()
//     {
//         /**
//           * Any of the functions stored in their respective
//           * resolve or reject arrays will not be used, since
//           * that code path is no longer reachable, but since
//           * the created MyPromise object will continue to technically
//           * have access to them, there is a significant chance that due
//           * to this the garbage collector may avoid freeing the memory
//           * associated with it until the MyPromise object gets freed. Since
//           * I can't delete private props, this is the next best thing
//           * to try to remedy the problem.
//           */
//         this.#consumingFunctionQueueFor = null;
//     }
// }

// Old version of MyPromise, promise chaining was not yet implemented!
// class MyPromise
// {
//     constructor(executor)
//     {
//         executor(this.#resolve.bind(this), this.#reject.bind(this));
//     }

//     then(onSuccess, onFailure)
//     {
//         const onSuccessIsAFunction = typeof onSuccess === "function";
//         const onFailureIsAFunction = typeof onFailure ===  "function";

//         switch (this.#state)
//         {
//             case MyPromise.#States.pending:
//             {
//                 if (onSuccessIsAFunction)
//                     this.#consumingFunctionQueueFor.resolve.push(onSuccess);
//                 if (onFailureIsAFunction)
//                     this.#consumingFunctionQueueFor.reject.push(onFailure);
//                 break;
//             }
//             case MyPromise.#States.fulfilled:
//             {
//                 if (onSuccessIsAFunction)
//                     onSuccess(this.#result)
//                 break;
//             }
//             case MyPromise.#States.rejected:
//             {
//                 if (onFailureIsAFunction)
//                     onFailure(this.#result)
//                 break;
//             }
//         }
//     }

//     catch(onFailure)
//     {
//         return this.then(null, onFailure);
//     }

//     static #States = Object.freeze({
//         pending: "pending",
//         fulfilled: "fulfilled",
//         rejected: "rejected",
//     });

//     #result = undefined;
//     #state = MyPromise.#States.pending;
//     #resolveOrRejectHasBeenExecuted = false;
//     #consumingFunctionQueueFor = {resolve: [], reject: []};

//     #resolve(successVal)
//     {
//         if (this.#resolveOrRejectHasBeenExecuted)
//             return;

//         this.#resolveOrRejectHasBeenExecuted = true;
//         this.#state = MyPromise.#States.fulfilled;
//         this.#result = successVal;

//         this.#consumingFunctionQueueFor.resolve.forEach(func => func(this.#result));
//         this.#cleanUpAfterResolvingOrRejecting();
//     }

//     #reject(errorVal)
//     {
//         if (this.#resolveOrRejectHasBeenExecuted)
//             return;

//         this.#resolveOrRejectHasBeenExecuted = true;
//         this.#state = MyPromise.#States.rejected;
//         this.#result = errorVal;

//         this.#consumingFunctionQueueFor.reject.forEach(func => func(this.#result));
//         this.#cleanUpAfterResolvingOrRejecting();
//     }

//     #cleanUpAfterResolvingOrRejecting()
//     {
//         /**
//          * Any of the functions stored in their respective
//          * resolve or reject arrays will not be used, since
//          * that code path is no longer reachable, but since
//          * the created MyPromise object will continue to have access
//          * to them, there is a significant chance that due to this
//          * the garbage collector may avoid freeing the memory
//          * associated with it until object destruction. Since
//          * I can't delete private props, this is the next best thing.
//          */
//         this.#consumingFunctionQueueFor = null;
//     }
// }
