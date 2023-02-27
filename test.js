/* eslint-disable no-console */

const _ = require('lodash'); // eslint-disable-line
const { MyPromise, isThenable } = require('./myPromise');

function createConsumer(consumerName)
{
    const consumer = ((value) =>
    {
        consumer.results.push(value);
        return `IGNORE: Default return value from ${consumer.consumerName}`;
    });
    consumer.consumerName = consumerName;
    consumer.results = [];
    return consumer;
}

function runPromiseTest({
    testInfo: { describe, it }, // mocha api like
    callbackfn,
    logCallbackResultsAlwaysBool = false,
    throwIfCallbackResultsNotEqBool = true,
})
{
    const PromiseTypes = [
        {
            promiseConstructor: Promise,
            name: 'ECMA Script Promise',
        },
        {
            promiseConstructor: MyPromise,
            name: 'My Promise',
        },
    ];

    const callbackEnvironments = PromiseTypes.map(({ promiseConstructor, name }) => (
        {
            promiseConstructor,
            consumerFuncs: {
                onSuccess: createConsumer(`${name} success`),
                onFailure: createConsumer(`${name} error`),
            },
        }));
    const maxConsumerNameLength = callbackEnvironments
        .reduce((len, { consumerFuncs: { onSuccess, onFailure } }) => Math.max(
            len,
            onSuccess.consumerName.length,
            onFailure.consumerName.length,
        ), 0);

    const callbackReturnedPromises = callbackEnvironments
        .map(({ promiseConstructor, consumerFuncs: { onSuccess, onFailure } }) => callbackfn(
            promiseConstructor,
            onSuccess,
            onFailure,
        ));
    if (callbackReturnedPromises.some((x) => !isThenable(x)))
    {
        throw Error('callback test function does not return a Thenable (Promise/MyPromise)!');
    }

    const processedAndConsumedPromises = callbackReturnedPromises
        .map((promiseObj, index) =>
        {
            const { consumerFuncs: { onSuccess, onFailure } } = callbackEnvironments[index];
            return promiseObj
                /**
                 * make sure to process errors and also force use of
                 * onSuccess and onFailure even if callbackfn doesn't
                 * use them so they can scrape the results of the promiseObj
                 */
                .then(onSuccess, onFailure);
        });
    return Promise
        .all(processedAndConsumedPromises) /** make sure every promise has been flattened */
        .then(() =>
        {
            const logCallbackResultsFunc = () =>
            {
                console.log('\tLogging Handler results:');
                callbackEnvironments.forEach((environment) => Object
                    .values(environment.consumerFuncs)
                    .forEach((consumer) =>
                    {
                        const paddingAmount = maxConsumerNameLength - consumer.consumerName.length;
                        console.log(`\t\t${consumer.consumerName}:${' '.repeat(paddingAmount)}\t results:`, consumer.results);
                    }));
            };

            const resultsAreEqBool = _.isEqual(...callbackEnvironments.map((environment) => Object
                .values(environment.consumerFuncs)
                .map((consumer) => consumer.results)));
            const msg = `\t${resultsAreEqBool ? 'SUCCESS' : 'FAILED'}: ${it}`;

            console.log(describe);
            if (!resultsAreEqBool && throwIfCallbackResultsNotEqBool)
            {
                logCallbackResultsFunc();
                throw Error(msg);
            }
            console.log(msg);
            if (logCallbackResultsAlwaysBool || !resultsAreEqBool) logCallbackResultsFunc();
            console.log(); // spacer
        });
}

/* eslint-disable max-len */
const testConfigurations = [
    {
        testInfo: { describe: 'Resolve a Promise (basic)', it: '.then should have access to the resolved value' },
        callbackfn: (PromiseType) => new PromiseType((resolve) => { resolve(42); }),
    },
    {
        testInfo: { describe: 'Resolve a Promise asynchronously (basic)', it: 'should allow for resolve to be used/called outside of passed in executor' },
        callbackfn: (PromiseType) => new PromiseType((resolve) => { setTimeout(() => resolve(49)); }),
    },
    {
        testInfo: { describe: 'Resolving array of Promises', it: 'should keep array as promises and not flatten' },
        callbackfn: (PromiseType) => new PromiseType(
            (resolve) =>
            {
                resolve([
                    new PromiseType((res) => res(4)),
                    new PromiseType((res) => res(2)),
                ]);
            },
        ).then((promiseArray) => promiseArray.map(isThenable)),
    },
    {
        testInfo: { describe: 'Resolving a new Promise', it: 'should wait and resolve value of promise instead of promise itself' },
        callbackfn: (PromiseType) => new PromiseType(
            (resolve) => { resolve(new PromiseType((res) => { res(42); })); },
        ),

    },
    {
        testInfo: { describe: 'Resolving a new Promise after timeout', it: 'testing async on top of async' },
        callbackfn: (PromiseType) => new PromiseType(
            (resolve) => { setTimeout(() => resolve(new PromiseType((res) => { res(42); }))); },
        ),
    },
    {
        testInfo: { describe: 'Resolving more than once', it: 'should only resolve once' },
        callbackfn: (PromiseType) => new PromiseType((resolve) => { resolve(1); resolve(2); }),
    },
    {
        testInfo: { describe: 'Resolving thenable and calling resolve async', it: 'test flattening edge case' },
        callbackfn: (PromiseType) => new PromiseType((resolve) =>
        {
            resolve(new PromiseType((res) => { res('hello'); }));
            setTimeout(() => resolve(2));
        }),
    },
    {
        testInfo: { describe: 'Resolve and reject more than once', it: 'All further calls of resolve and reject are ignored' },
        callbackfn: (PromiseType) => new PromiseType((resolve, reject) =>
        {
            resolve('done');
            reject(new Error('...'));
            setTimeout(() => resolve('...'));
        }),
    },
    {
        testInfo: { describe: 'Letting rejected value bubble through', it: 'if errorVal is not caught should bubble right through' },
        callbackfn: (PromiseType, onSuccess, onFailure) => new PromiseType((resolve, reject) => { reject(41); })
            .then(onSuccess)
            .then(onSuccess, (errorVal) => { throw `${errorVal} yeah I rethrow >:)`; }) // eslint-disable-line no-throw-literal
            .catch(onFailure),
    },
];
/* eslint-enable max-len */

/**
 * Use reduce to run tasks as they appear
 * in testConfigurations array (aka in order)
 */
testConfigurations.reduce(
    (currTestRunPromise, { callbackfn, testInfo: { describe, it } }, index) => currTestRunPromise
        .then(() => runPromiseTest({
            testInfo: { describe: `#${index}. ${describe}`, it },
            callbackfn,
            logCallbackResultsAlwaysBool: true,
            throwIfCallbackResultsNotEqBool: false,
        })),
    new Promise((resolve) => { resolve(); }),
).then(() => console.log('DONE!'));
