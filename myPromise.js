function isThenable(obj)
{
    return typeof obj?.then === 'function'
    && obj.then.length >= 1;
}

function flattenThenable(input, resolveFuncArg, rejectFuncArg)
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
            (successVal) => resolveFuncArg(successVal),
            (errorVal) => rejectFuncArg(errorVal),
        );
    }
    catch (errorVal)
    {
        rejectFuncArg(errorVal);
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
            if (errorVal instanceof TypeError) throw errorVal;
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
        const onSuccess = typeof onSuccessArg === 'function' ? onSuccessArg : (successVal) => successVal;
        const onFailure = typeof onFailureArg === 'function' ? onFailureArg : (errorVal) => { throw errorVal; };

        const getExecutor = (consumerFn) => (resolveFuncArg, rejectFuncArg) =>
        {
            try { resolveFuncArg(consumerFn(this.#result)); }
            catch (errorVal) { rejectFuncArg(errorVal); }
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
            {
                throw Error('Should never get to this code path; fix your code!');
            }
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
             * do nothing with successVal (which will be this.#result)
             * and just pass to value to the next promise
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
    #haveToFlattenThenable = false;
    #resolveOrRejectHaveBeenPrevCalledByExecutor = false;
    #consumingFunctionQueueFor = { resolve: [], reject: [] };

    #resolve = (successVal) =>
    {
        this.#resolveRejectCore({
            value: successVal,
            from: 'resolve',
        });
    };

    #reject = (errorVal) =>
    {
        this.#resolveRejectCore({
            value: errorVal,
            from: 'reject',
        });
    };

    #resolveRejectCore({ value /** successVal or errorVal */, from /** reject or resolve */ })
    {
        /**
         * Don't allow for more than one explicit call
         * to resolve (or reject) from executor.
         * Do allow for internal extra calls if need to flatten
         * value
         */
        if (this.#resolveOrRejectHaveBeenPrevCalledByExecutor
            && !this.#haveToFlattenThenable) return;

        this.#haveToFlattenThenable = false;
        this.#resolveOrRejectHaveBeenPrevCalledByExecutor = true;
        setTimeout(() =>
        {
            if (isThenable(value))
            {
                /**
                 * this.#haveToFlattenThenable needs to be set to
                 * true before calling flattenThenable(...) since
                 * if value.then calls this.#resolve (or this.#reject)
                 * immediately, it won't run due to the blocking first if
                 * condition in the subsequent resolveRejectCore call.
                 */
                this.#haveToFlattenThenable = true;
                flattenThenable(value, this.#resolve, this.#reject);
                return;
            }

            /**
             * this.#result MUST be set before executing
             * their respective consumingFunctionQueues
             * since each function call is a closure with .then's
             * getExecutor function that returns another closure
             * that uses this.#result.
             */
            this.#result = value;
            this.#state = from === 'reject' ? MyPromise.#States.rejected : MyPromise.#States.fulfilled;
            this.#consumingFunctionQueueFor[from].forEach((func) => func());
            this.#cleanUpAfterResolvingOrRejecting();
        }, 0);
    }

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

        promiseArray.forEach((promise, index) =>
        {
            if (!isThenable(promise))
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
        const resolveHandler = (value) => ({ status: 'fulfilled', value });
        const rejectHandler = (reason) => ({ status: 'rejected', reason });
        const promiseArray = Array.isArray(promiseCollection)
            ? promiseCollection : [...promiseCollection];
        const convertedPromises = promiseArray
            .map((promise) => MyPromise.resolve(promise).then(resolveHandler, rejectHandler));

        return Promise.all(convertedPromises);
    }

    static race(promiseCollection)
    {
        const promiseArray = Array.isArray(promiseCollection)
            ? promiseCollection : [...promiseCollection];
        const returningPromise = new MyPromise(() => {});

        promiseArray.forEach((promise) =>
        {
            /** Force each "promise" to be for sure a Promise type or at least thenable */
            MyPromise.resolve(promise).then(
                (successVal) => { returningPromise.#resolve(successVal); },
                (errorVal) => { returningPromise.#reject(errorVal); },
            );
        });

        return returningPromise;
    }

    static any(promiseCollection)
    {
        const promiseArray = Array.isArray(promiseCollection)
            ? promiseCollection : [...promiseCollection];
        const returningPromise = new MyPromise(() => {});
        const errors = new Array(promiseArray.length);
        let numOfErrors = 0;

        promiseArray.forEach((promise, index) =>
        {
            /** Force each "promise" to be for sure a Promise type or at least thenable */
            MyPromise.resolve(promise).then(
                (successVal) => { returningPromise.#resolve(successVal); },
                (errorVal) =>
                {
                    numOfErrors += 1;
                    errors[index] = errorVal;
                    /**
                     * in real Promise, rejected value is an object that
                     * contains prop 'errors' which is an array
                     */
                    if (numOfErrors === promiseArray.length) returningPromise.#reject({ errors });
                },
            );
        });

        return returningPromise.then();
    }

    static resolve(input)
    {
        if (isThenable(input)) return input;
        return new MyPromise((resolve) => resolve(input));
    }

    static reject(input)
    {
        if (isThenable(input)) return input;
        return new MyPromise((resolve, reject) => reject(input));
    }
}

module.exports = { MyPromise, isThenable };
