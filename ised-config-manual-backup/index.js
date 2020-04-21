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
            const snapshots = data.Snapshots,
                nbSnapshots = snapshots.length;

            let volumesWithManualSnaphots = [],
                i, j, snapshot, tags, nbTags, tag, automated,
                volumesWithNoManualSnapshots;

            for ( i = 0; i < nbSnapshots; i += 1 ) {
                automated = false;
                snapshot = snapshots[ i ];
                tags = snapshot.tags;
                nbTags = tags.length;

                for ( j = 0; j < nbTags; j += 1 ) {
                    tag = tags[ j ];

                    // This is an automated snapshot
                    if ( tag.Name === "ised-backup-type" && tag.Value === "automated" ) {
                        automated = true;
                        break;
                    }
                }

                if ( automated === false ) {
                    volumesWithManualSnaphots.push( snapshot.VolumeId );
                }
            }

            // Find items in the volumeBatch array that aren't in volumesWithManualSnaphots
            volumesWithNoManualSnapshots = volumeBatch.filter( volume => !volumesWithManualSnaphots.includes( volume.VolumeId ) );

            return Promise.resolve( volumesWithNoManualSnapshots );
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
 * of the DBInstanceIdentifier for each object.
 */
function extractDBInstanceIdentifiers( objArr ) {
    return objArr.map( function( obj ) {
            return obj.DBInstanceIdentifier;
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
        .then( ( batchesOfNonCompliantVolumes ) => {
            let i, j, nbNonCompliantVolumes, nonCompliantVolume,
                nonCompliantVolumes,
                evaluations = [],
                nbBatches = batchesOfNonCompliantVolumes.length;

            for ( i = 0; i < nbBatches; i += 1 ) {
                nonCompliantVolumes = batchesOfNonCompliantVolumes[ i ];
                nbNonCompliantVolumes = nonCompliantVolumes.length;

                for ( j = 0; j < nbNonCompliantVolumes; j += 1) {
                    nonCompliantVolume = nonCompliantVolumes[ j ].VolumeId;

                    evaluations.push( {
                        ComplianceResourceType: 'AWS::EC2::Volume',
                        ComplianceResourceId: nonCompliantVolume,
                        ComplianceType: "NON_COMPLIANT",
                        OrderingTimestamp: new Date(),
                    } );
                }
            }

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
