import boto3

def handler(event, context):
    ec2 = boto3.client("ec2")
    rds = boto3.client("rds")

    resource_id = event["ResourceId"].strip()

    if resource_id.startswith("i-"):
        # EC2 resource ids start with "i-"
        print("Enabling on ec2: " + resource_id)
        ec2.modify_instance_attribute(DisableApiTermination={"Value": True}, InstanceId=resource_id)
    else:
        # RDS resource ids start with "db-", we could check for that here
        print("Enabling on rds: " + resource_id)

        # Doesn't seem like there's a way to directly get a dbInstanceId from
        # the resource id, so filter all our RDSes down to the one that matches
        # the resource id and grab its dbInstanceId
        dbInstance = rds.describe_db_instances(Filters=[{
            "Name": "dbi-resource-id",
            "Values": [resource_id]
        }])

        if len(dbInstance) > 0:
            dbId = dbInstance["DBInstances"][0]["DBInstanceIdentifier"]
            print("The db id: " + dbId)
            rds.modify_db_instance(DeletionProtection=True, DBInstanceIdentifier=dbId)
        else:
            raise Exception("Couldn't find target RDS: " + resource_id + " (" + dbId + ")")
