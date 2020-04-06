'use strict';

const aws = require('aws-sdk');
const iam = new aws.IAM();
const ses = new aws.SES();

// AWS Lambda handler
exports.handler = (event, context, cfn_callback) => {
    function sortKeysByAscendingCreationDate( keyA, keyB ) {
        const dateA = new Date( keyA.CreateDate ),
            dateB = new Date( keyB.CreateDate );

        if ( dateA > dateB ) {
            return -1;
        }

        if ( dateB > dateA ) {
            return 1;
        }

        return 0;
    }

    function notifyUser( username, newKey, oldKey ) {
        iam.getUser( { "UserName": username }, function( err, data ) {
            if ( err ) {
                console.log( err, err.stack );

                cfn_callback( err, {
                    message: "Failed to get user details: " + username,
                    event
                } );
            } else {
                // Find the ised-contact-email tag and get the value
                let tags = data.User.Tags,
                    nbTags = tags.length,
                    email = "",
                    i, tag, message, emailParams;

                for ( i = 0; i < nbTags; i += 1 ) {
                    tag = tags[ i ];

                    if ( tag.Key === "ised-contact-email" ) {
                        email = tag.Value;
                        break;
                    }
                }

                message = `The IAM key ${oldKey.AccessKeyId} will expire in 30 days.
Replace it with the following information:

ID: ${newKey.AccessKeyId}
Secret: ${newKey.SecretAccessKey}`;

                if ( email !== "" ) {
                    // FIXME: Is email really a secure channel?
                    //        Could encrypt the email/attachment with KMS...
                    sendEmail( email, message );
                }
            }
        } );
    }

    function sendEmail( email, message ) {
        // NOTE: This email address need to be verified.
        let fromEmail = event.FromEmail,
            params = {
                Destination: {
                    ToAddresses: [
                        email
                    ]
                },
                Message: {
                    Body: {
                        Text: {
                            Charset: "UTF-8",
                            Data: message
                        }
                    },
                    Subject: {
                        Charset: "UTF-8",
                        Data: "IAM Key Expiry Notice"
                    }
                },
                Source: fromEmail
            };

        ses.sendEmail( params, function( err, data ) {
            if ( err ) {
                console.log( err, err.stack );

                cfn_callback( err, {
                    message: "Failed to send email",
                    event
                } );
            } else {
                console.log( "Key expiry notice email sent to: " + email );

                cfn_callback( null, {
                    message: "Email sent successfully",
                    event
                } );
            }
        } );
    }

    function createAccessKey( username, oldKey ) {
        const createAccessKeyParams = {
            "UserName": username
        };

        iam.createAccessKey( createAccessKeyParams, function( err, data ) {
            if ( err ) {
                console.log( err, err.stack );
                
                cfn_callback( err, {
                    message: "Failed to create keys",
                    event
                } );
            } else {
                console.log( "Access key for user " + username + " created: " + data.AccessKey.AccessKeyId );
                notifyUser( username, data.AccessKey, oldKey );
            }
        } );
    };

    // Get all IAM users in this account
    iam.listUsers( {}, function( err, data ) {
        var users,
            user,
            nbUsers,
            i,
            username,
            listAccessKeysParams;

        if ( err ) {
            console.log( err, err.stack );

            cfn_callback( err, {
                message: "Failed to list users",
                event
            } );

            return;
        }

        users = data.Users;
        nbUsers = users.length;

        // For each user, list their keys
        for ( i = 0; i < nbUsers; i += 1 ) {
            user = users[ i ];
            username = user.UserName;
            listAccessKeysParams = {
                "UserName": username
            };

            console.log( "User: " + username );

            iam.listAccessKeys( listAccessKeysParams, function( err, data ) {
                let key,
                    keys,
                    nbKeys,
                    i,
                    keyCreationDate,
                    createAccessKeyParams,
                    deleteAccessKeyParams,
                    today = new Date(),
                    sixtyDays = 60 * 24 * 60 * 60 * 1000, // 60 days in milliseconds
                    sixtyOneDays = 61 * 24 * 60 * 60 * 1000, // 61 days in milliseconds
                    ninetyDays = 90 * 24 * 60 * 60 * 1000; // 90 days in milliseconds

                if ( err ) {
                    console.log( err, err.stack );

                    cfn_callback( err, {
                        message: "Failed to list keys",
                        event
                    } );

                    return;
                }

                keys = data.AccessKeyMetadata;
                nbKeys = keys.length;

                // User has no keys, nothing to do
                if ( nbKeys === 0 ) {
                    return;
                }

                // Sort keys by creation date so we delete
                // old keys before trying to create new ones
                keys.sort( sortKeysByAscendingCreationDate );

                for ( i = 0; i < nbKeys; i += 1 ) {
                    key = keys[ i ];
                    keyCreationDate = new Date( key.CreateDate );

                    // Key is older than 90 days, delete
                    if ( today - keyCreationDate >= ninetyDays ) {
                        deleteAccessKeyParams = {
                            "UserName": username,
                            "AccessKeyId": key.AccessKeyId
                        };

                        iam.deleteAccessKey( deleteAccessKeyParams, function( err, data ) {
                            if ( err ) {
                                console.log( err, err.stack );

                                cfn_callback( err, {
                                    message: "Failed to delete key: " + key.AccessKeyId,
                                    event
                                } );
                            } else {
                                console.log( "Access key for user " + username + " deleted: " + key.AccessKeyId );
                            }
                        } );
                    } else {
                        if ( today - keyCreationDate >= sixtyDays && today - keyCreationDate < sixtyOneDays ) {
                            createAccessKey( username, key );
                        } else {
                            console.log( "Key " + key.AccessKeyId + " isn't due for notification or deletion" );
                        }
                    }
                }
            } );
        }
    } );

    return context.logStreamName;
}
