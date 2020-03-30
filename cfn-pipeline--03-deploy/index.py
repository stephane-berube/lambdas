import json
import boto3

s3 = boto3.resource("s3")
ssm_client = boto3.client('ssm')
cfn_client = boto3.client("cloudformation")
code_pipeline = boto3.client("codepipeline")

# TODO: We need to update the version number in the "Description" property in the StackSet to match the last comment
#       and then upload that new file to the proper s3 location

# Example "Test Event" Data:
#
# A string containing JSON that will be fed to json.loads()
#
# {
#    "ised_test": "[{\"name\": \"ised-backup\",  \"filename\": \"backup.yaml\",  \"parameters\": \"backup.json\"}]"
# }

def lambda_handler(event, context):
    # If we're running in a pipeline, grab the stacksets to execute from the
    # earlier pipeline step
    if "CodePipeline.job" in event:
        # TODO: What happens if there are none?
        stacksets_to_deploy = event["CodePipeline.job"]["data"]["actionConfiguration"]["configuration"]["UserParameters"]
    # Otherwise, we're probably testing from the lambda console so grab a
    # static list of stacksets from our ised_test parameter
    else:
        stacksets_to_deploy = event["ised_test"]

    TemplateBaseURL = ssm_client.get_parameter(Name="S3Templates")["Parameter"]["Value"]

    stacksets_to_deploy = json.loads(stacksets_to_deploy)

    # Update stacksets
    for stackset in stacksets_to_deploy:
        print("Processing " +  stackset["name"])

        # Get parameters for this stackset
        obj = s3.Object("sb-stackset-test", "cf-parameters/" + stackset["parameters"])
        parameters_from_s3 = json.loads(obj.get()['Body'].read().decode('utf-8') )

        TemplateURL = TemplateBaseURL + "cf-stacks/" + stackset["filename"]

        # Default "Capabilities" is empty; no additional permissions required
        Capabilities = []

        # The "roles" stackset requires additional permissions
        if stackset["name"] == "ised-roles":
            Capabilities = ["CAPABILITY_NAMED_IAM"]

        cfn_client.update_stack_set(
            StackSetName=stackset["name"],
            TemplateURL=TemplateURL,
            Parameters=parameters_from_s3,
            Capabilities=Capabilities
        )

        print(
            "StackSetName: " + stackset["name"] +
            "TemplateURL: " + TemplateBaseURL + "cf-stacks/" + stackset["filename"]  +
            "Parameters: " + json.dumps(parameters_from_s3)
        )

    # If this lambda is being run as part of a pipeline, signal a "success"
    # so the pipeline can proceed to the next step
    if "CodePipeline.job" in event:
        jobId = event["CodePipeline.job"]["id"]
        code_pipeline.put_job_success_result(jobId=jobId)

    return