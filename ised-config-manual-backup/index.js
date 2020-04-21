const aws = require( "aws-sdk" );

const rds = new aws.RDS();
const ec2 = new aws.EC2();
const config = new aws.ConfigService();

// Checks whether the invoking event is ScheduledNotification
function isScheduledNotification( invokingEvent ) {
    return ( invokingEvent.messageType === "ScheduledNotification" );
}

function getDBs() {
    // TODO: Pagination
    return rds.describeDBInstances().promise();
}

function getVolumes() {
    // TODO: Pagination
    return ec2.describeVolumes().promise();
}

/**
 * Check if there are manual snapshots for every
 * volume in the batch
 */
function checkForEBSManualSnapshot( volumeBatch ) {
    return getBatchEBSSnapshots( volumeBatch )
        .then( ( data ) => {
            const snapshots = data.Snapshots;

            let volumesWithManualSnaphots = [],
                complianceResults = [],
                compliantVolumeIds = [];

            snapshots.forEach( ( snapshot ) => {
                let automated = false,
                    tags = snapshot.Tags;

                tags.forEach( ( tag ) => {
                    // This is an automated snapshot
                    if ( tag.Name === "ised-backup-type" && tag.Value === "automated" ) {
                        automated = true;
                    }
                } );

                if ( automated === false ) {
                    // Associative array just so we don't end up with duplicates...
                    volumesWithManualSnaphots[ snapshot.VolumeId ] = {
                        volumeId: snapshot.VolumeId,
                        compliance: "COMPLIANT"
                    };
                }
            } );

            // Get the list of volumes with manual snapshots in a "non-associative" array
            for ( const volumeId in volumesWithManualSnaphots ) {
                complianceResults.push( volumesWithManualSnaphots[ volumeId ] );
                compliantVolumeIds.push( volumeId );
            }

            volumeBatch.forEach( ( volume ) => {
                if ( !compliantVolumeIds.includes( volume.VolumeId ) ) {
                    complianceResults.push( {
                        volumeId: volume.VolumeId,
                        compliance: "NON_COMPLIANT"
                    } );
                }
            } );

            return Promise.resolve( complianceResults );
        } );
}

/**
 * Get snapshots for the list of provided volumes
 */
function getBatchEBSSnapshots( volumes ) {
    let i, volume, volumeIds = [];

    for ( i = 0; i < volumes.length; i += 1 ) {
        volume = volumes[ i ];

        volumeIds.push( volume.VolumeId );
    }

    const params = {
        Filters: [
            {
                Name: "volume-id",
                Values: volumeIds
            }
        ]
    };

    // TODO: Pagination
    return ec2.describeSnapshots( params ).promise();
}

function getManualRDSSnapshots() {
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
 * of the DbiResourceId for each object.
 */
function extractDBInstanceIdentifiers( objArr ) {
    return objArr.map( function( obj ) {
            return obj.DbiResourceId;
        } );
}

function checkVolumes( event ) {
    return getVolumes()
        // Check if they have a manual snapshot
        .then( ( data ) => {
            let volumes = data.Volumes,
                batch,
                promises = [];

            while( volumes.length > 0 ) {
                batch = volumes.splice( 0, 30 );

                promises.push(
                    checkForEBSManualSnapshot( batch )
                );
            }

            return Promise.all( promises );
        } )
        // Build the "evalution" response AWS Config expects so it can
        // flag non-compliant resources
        .then( ( batchesComplianceResults ) => {
            let evaluations = [];

            batchesComplianceResults.forEach( ( complianceResults ) => {
                complianceResults.forEach( ( complianceResult ) => {
                    evaluations.push( {
                        ComplianceResourceType: 'AWS::EC2::Volume',
                        ComplianceResourceId: complianceResult.volumeId,
                        ComplianceType: complianceResult.compliance,
                        OrderingTimestamp: new Date(),
                    } );
                } );
            } );

            // Initializes the request that contains the evaluation results.
            const putEvaluationsRequest = {
                Evaluations: evaluations,
                ResultToken: event.resultToken,
            };

            return config.putEvaluations( putEvaluationsRequest ).promise();
        } );
}

function checkRDS( event ) {
    return Promise.all( [ getDBs(), getManualRDSSnapshots() ] )
        .then( ( data ) => {
            const DBInstanceIdentifiers = extractDBInstanceIdentifiers( data[ 0 ].DBInstances ),
                manualSnapshotsDBInstanceIdentifier = extractDBInstanceIdentifiers( data[ 1 ].DBSnapshots ),
                DBInstanceIdentifiersWithNoManualSnapshots = findDBInstanceIdentifiersWithNoManualSnapshots( DBInstanceIdentifiers, manualSnapshotsDBInstanceIdentifier );

            let compliantDBInstanceIdentifiers, nonCompliantEvaluations,
                compliantEvaluations, evaluations;

            compliantDBInstanceIdentifiers = DBInstanceIdentifiers.filter( ( dbId ) => {
                return !DBInstanceIdentifiersWithNoManualSnapshots.includes( dbId );
            } );

            nonCompliantEvaluations = DBInstanceIdentifiersWithNoManualSnapshots.map( function( dbId ) {
                return {
                    ComplianceResourceType: 'AWS::RDS::DBInstance',
                    ComplianceResourceId: dbId,
                    ComplianceType: "NON_COMPLIANT",
                    OrderingTimestamp: new Date(),
                };
            } );

            compliantEvaluations = compliantDBInstanceIdentifiers.map( ( dbId ) => {
                return {
                    ComplianceResourceType: 'AWS::RDS::DBInstance',
                    ComplianceResourceId: dbId,
                    ComplianceType: "COMPLIANT",
                    OrderingTimestamp: new Date(),
                };
            } );

            evaluations = nonCompliantEvaluations.concat( compliantEvaluations );

            // Initializes the request that contains the evaluation results.
            const putEvaluationsRequest = {
                Evaluations: evaluations,
                ResultToken: event.resultToken,
            };

            return config.putEvaluations( putEvaluationsRequest ).promise();
        } );
}

exports.handler = async ( event ) => {
    // Parses the invokingEvent and ruleParameters values, which contain JSON objects passed as strings.
    const invokingEvent = JSON.parse( event.invokingEvent );

    if ( !( isScheduledNotification( invokingEvent ) ) ) {
        return Promise.resolve( "Invoked for a notification other than Scheduled Notification... Ignoring." );
    }

    return Promise.all( [ checkVolumes( event ), checkRDS( event ) ] );
};
