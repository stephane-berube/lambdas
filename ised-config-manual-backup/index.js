const aws = require( "aws-sdk" );

const rds = new aws.RDS();
const config = new aws.ConfigService();

// Checks whether the invoking event is ScheduledNotification
function isScheduledNotification( invokingEvent ) {
    return ( invokingEvent.messageType === "ScheduledNotification" );
}

function getDBs() {
    // TODO: Pagination
    return rds.describeDBInstances().promise();
}

function getManualSnapshots() {
    // TODO: Pagination
    return rds.describeDBSnapshots( {
        SnapshotType: "manual"
    } ).promise();
}

/**
 * Find DBInstanceIdentifiers that appear in DBInstanceIdentifiers, but not
 * in manualSnapshotsDBInstanceIdentifier
 */
function findDBInstanceIdentifiersWithNoManualSnapshots( DBInstanceIdentifiers, manualSnapshotsDBInstanceIdentifier ) {
    return DBInstanceIdentifiers.filter( function( DBInstanceIdentifier ) {
        return manualSnapshotsDBInstanceIdentifier.indexOf( DBInstanceIdentifier ) === -1;
    } );
}

/**
 * For a given array of objects (DBInstance, Snapshots), return an array
 * of the DBInstanceIdentifier for each object.
 */
function extractDBInstanceIdentifiers( objArr ) {
    return objArr.map( function( obj ) {
            return obj.DBInstanceIdentifier;
        } );
}

exports.handler = async ( event ) => {
    // Parses the invokingEvent and ruleParameters values, which contain JSON objects passed as strings.
    const invokingEvent = JSON.parse( event.invokingEvent );

    if ( !( isScheduledNotification( invokingEvent ) ) ) {
        return Promise.resolve( "Invoked for a notification other than Scheduled Notification... Ignoring." );
    }

    return Promise.all( [ getDBs(), getManualSnapshots() ] )
        .then( ( data ) => {
            const DBInstanceIdentifiers = extractDBInstanceIdentifiers( data[ 0 ].DBInstances ),
                manualSnapshotsDBInstanceIdentifier = extractDBInstanceIdentifiers( data[ 1 ].DBSnapshots ),
                DBInstanceIdentifiersWithNoManualSnapshots = findDBInstanceIdentifiersWithNoManualSnapshots( DBInstanceIdentifiers, manualSnapshotsDBInstanceIdentifier );

            const Evaluations = DBInstanceIdentifiersWithNoManualSnapshots.map( function( dbId ) {
                return {
                    ComplianceResourceType: 'AWS::RDS::DBInstance',
                    ComplianceResourceId: dbId,
                    ComplianceType: "NON_COMPLIANT",
                    OrderingTimestamp: new Date(),
                };
            } );

            // Initializes the request that contains the evaluation results.
            const putEvaluationsRequest = {
                Evaluations: Evaluations,
                ResultToken: event.resultToken,
            };

            return config.putEvaluations( putEvaluationsRequest ).promise();
        } )
        .catch( ( err ) => {
            console.log( "Promise.all failed: " );
            console.log( err );

            // Notify lambda that this failed
            return Promise.reject( err );
        } );
};
