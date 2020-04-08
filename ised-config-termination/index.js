// This code is based on the "config-rule-change-triggered" Lambda Blueprint
// Most of the modifications are in the "evaluateChangeNotificationCompliance"
// function and the handler export

const aws = require('aws-sdk');
const config = new aws.ConfigService();
const ec2 = new aws.EC2();
const rds = new aws.RDS();

// Helper function used to validate input
function checkDefined(reference, referenceName) {
    if (!reference) {
        throw new Error(`Error: ${referenceName} is not defined`);
    }
    return reference;
}

// Check whether the message is OversizedConfigurationItemChangeNotification or not
function isOverSizedChangeNotification(messageType) {
    checkDefined(messageType, 'messageType');
    return messageType === 'OversizedConfigurationItemChangeNotification';
}

// Get configurationItem using getResourceConfigHistory API.
function getConfiguration(resourceType, resourceId, configurationCaptureTime, callback) {
    config.getResourceConfigHistory({ resourceType, resourceId, laterTime: new Date(configurationCaptureTime), limit: 1 }, (err, data) => {
        if (err) {
            callback(err, null);
        }
        const configurationItem = data.configurationItems[0];
        callback(null, configurationItem);
    });
}

// Convert from the API model to the original invocation model
/*eslint no-param-reassign: ["error", { "props": false }]*/
function convertApiConfiguration(apiConfiguration) {
    apiConfiguration.awsAccountId = apiConfiguration.accountId;
    apiConfiguration.ARN = apiConfiguration.arn;
    apiConfiguration.configurationStateMd5Hash = apiConfiguration.configurationItemMD5Hash;
    apiConfiguration.configurationItemVersion = apiConfiguration.version;
    apiConfiguration.configuration = JSON.parse(apiConfiguration.configuration);
    if ({}.hasOwnProperty.call(apiConfiguration, 'relationships')) {
        for (let i = 0; i < apiConfiguration.relationships.length; i++) {
            apiConfiguration.relationships[i].name = apiConfiguration.relationships[i].relationshipName;
        }
    }
    return apiConfiguration;
}

// Based on the type of message get the configuration item either from configurationItem in the invoking event or using the getResourceConfigHistiry API in getConfiguration function.
function getConfigurationItem(invokingEvent, callback) {
    checkDefined(invokingEvent, 'invokingEvent');
    if (isOverSizedChangeNotification(invokingEvent.messageType)) {
        const configurationItemSummary = checkDefined(invokingEvent.configurationItemSummary, 'configurationItemSummary');
        getConfiguration(configurationItemSummary.resourceType, configurationItemSummary.resourceId, configurationItemSummary.configurationItemCaptureTime, (err, apiConfigurationItem) => {
            if (err) {
                callback(err);
            }
            const configurationItem = convertApiConfiguration(apiConfigurationItem);
            callback(null, configurationItem);
        });
    } else {
        checkDefined(invokingEvent.configurationItem, 'configurationItem');
        callback(null, invokingEvent.configurationItem);
    }
}

// Check whether the resource has been deleted. If it has, then the evaluation is unnecessary.
function isApplicable(configurationItem, event) {
    checkDefined(configurationItem, 'configurationItem');
    checkDefined(event, 'event');
    const status = configurationItem.configurationItemStatus;
    const eventLeftScope = event.eventLeftScope;
    return (status === 'OK' || status === 'ResourceDiscovered') && eventLeftScope === false;
}

// This is where it's determined whether the resource is compliant or not.
// In this example, we simply decide that the resource is compliant if it is an instance and its type matches the type specified as the desired type.
// If the resource is not an instance, then we deem this resource to be not applicable. (If the scope of the rule is specified to include only
// instances, this rule would never have been invoked.)
function evaluateChangeNotificationCompliance(configurationItem) {
    checkDefined(configurationItem, 'configurationItem');
    checkDefined(configurationItem.configuration, 'configurationItem.configuration');

    const resourceType = configurationItem.resourceType;
    let params = {};

    if (resourceType === 'AWS::EC2::Instance') {
        params = {
            Attribute: "disableApiTermination",
            InstanceId: configurationItem.configuration.instanceId
        };

        return ec2.describeInstanceAttribute(params)
                .promise()
                .then(function(data) {
                    if (data.DisableApiTermination.Value === true) {
                        return Promise.resolve("COMPLIANT");
                    } else {
                        return Promise.resolve("NON_COMPLIANT");
                    }
                });
    } else {
        if (resourceType === 'AWS::RDS::DBInstance') {
            params = {
                DBInstanceIdentifier: configurationItem.configuration.dBInstanceIdentifier
            };

            return rds.describeDBInstances(params)
                    .promise()
                    .then(function(data) {
                        if (data.DBInstances[0].DeletionProtection === true) {
                            return Promise.resolve("COMPLIANT");
                        } else {
                            return Promise.resolve("NON_COMPLIANT");
                        }
                    });
        } else {
            return Promise.resolve('NOT_APPLICABLE');
        }
    }
}

exports.handler = (event, context, callback) => {
    checkDefined(event, 'event');
    const invokingEvent = JSON.parse(event.invokingEvent);
    getConfigurationItem(invokingEvent, (err, configurationItem) => {
        if (err) {
            callback(err);
        }

        let compliancePromise;
        const putEvaluationsRequest = {};

        if (isApplicable(configurationItem, event)) {
            // Invoke the compliance checking function.
            compliancePromise = evaluateChangeNotificationCompliance(configurationItem);

            compliancePromise.then(function(compliance) {
                // Put together the request that reports the evaluation status
                putEvaluationsRequest.Evaluations = [
                    {
                        ComplianceResourceType: configurationItem.resourceType,
                        ComplianceResourceId: configurationItem.resourceId,
                        ComplianceType: compliance,
                        OrderingTimestamp: configurationItem.configurationItemCaptureTime,
                    },
                ];
                putEvaluationsRequest.ResultToken = event.resultToken;

                // Invoke the Config API to report the result of the evaluation
                config.putEvaluations(putEvaluationsRequest, (error, data) => {
                    if (error) {
                        callback(error, null);
                    } else if (data.FailedEvaluations.length > 0) {
                        // Ends the function execution if any evaluation results are not successfully reported.
                        callback(JSON.stringify(data), null);
                    } else {
                        callback(null, data);
                    }
                });
            });
        }
    });
};
