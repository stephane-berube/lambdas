import boto3
import json
import os

s3 = boto3.resource("s3")
s3_client = boto3.client("s3")
cfn_client = boto3.client("cloudformation")
code_pipeline = boto3.client("codepipeline")

def lambda_handler(event, context):
    different_stacksets = []
    different_message = []
    stacksets = []
    bucket_name = os.environ['BucketName']

    # Iterate through the files in the "cf-stacks" folder and grab the filenames
    for p in s3_client.get_paginator("list_objects_v2").paginate(Bucket=bucket_name, Prefix="cf-stacks"):
        for e in p["Contents"]:
            key = e["Key"]

            # Remove the folder name from the "key" to get the filename
            # ex: from "cf-stacks/backup.yaml" to "backup.yaml"
            filename = key.split("/")[1]

            # Remove the filename suffix (".yaml") to get just the basename
            base_filename = filename.split(".")[0]

            # name: The stackset name (the name used in CFN)
            #       This is "base_filename" prefixed with "ised-" (ex: "ised-backup")
            # filename: The filename in the repo/bucket (ex: backup.yaml)
            # parameters: The filename that contains parameters for this stackset
            #       This is "filename" but with ".json" suffix instead of ".yaml"
            stacksets.append({
                "name": "ised-" + base_filename,
                "filename": filename,
                "parameters": base_filename + ".json"
            })

    for stackset in stacksets:
        # We create new stacksets in CFN manually (for now), so if there's a
        # stackset that exists in the repository but not in CFN, skip it.
        try:
            response = cfn_client.describe_stack_set(
                StackSetName=stackset["name"]
            )
        except cfn_client.exceptions.StackSetNotFoundException:
            print(stackset["name"] + " doesn't exist in CFN. Skipping...")
            continue

        print("Processing: " + stackset["filename"])

        # Get template contents from described CFN and S3
        contents_from_cfn = response["StackSet"]["TemplateBody"]
        obj = s3.Object(bucket_name, "cf-stacks/" + stackset["filename"])
        contents_from_s3 = obj.get()['Body'].read().decode('utf-8')

        # Compare template contents
        if contents_from_cfn != contents_from_s3:
            different_message.append(stackset["name"] + ": different because of contents")
            different_stacksets.append(stackset)

            # No need to compare anything else, we'll run this stackset
            continue

        # Get template parameters from described CFN and S3
        parameters_from_cfn = response["StackSet"]["Parameters"]
        obj = s3.Object(bucket_name, "cf-parameters/" + stackset["parameters"])
        parameters_from_s3 = json.loads(obj.get()['Body'].read().decode('utf-8') )

        # If the number of params are different, no need to compare, re-run the stackset
        if (len(parameters_from_cfn) != len(parameters_from_s3)):
            different_message.append(stackset["name"] + ": different because diff nb of params")
            different_stacksets.append(stackset)
            continue

        # Build dict out of param for ease of access. We don't want to loop
        # through this array for every item in the parameters_from_cfn array...
        param_dict_from_s3 = dict()

        for parameter_from_s3 in parameters_from_s3:
            param_dict_from_s3[parameter_from_s3["ParameterKey"]] = parameter_from_s3["ParameterValue"]

        for parameter_from_cfn in parameters_from_cfn:
            # Skip comparing "password" parameters "NoEcho" since CFN describe
            # doesn't return the actual password, but "****" instead
            if parameter_from_cfn["ParameterValue"] == "****":
                continue

            # Parameter exists in CFN, but not in S3, consider this a
            # difference, flag stackset to be rerun and move on to comparing
            # the next one
            if parameter_from_cfn["ParameterKey"] not in param_dict_from_s3:
                different_message.append(stackset["name"] + ": different because diff keys")
                different_stacksets.append(stackset)
                break

            # Parameter values are different, re-run stack flag stackset to be
            # rerun and move on to comparing the next one
            if param_dict_from_s3[parameter_from_cfn["ParameterKey"]] != parameter_from_cfn["ParameterValue"]:
                different_message.append(stackset["name"] + ": different because params are diff (" + parameter_from_cfn["ParameterKey"] + ": " + parameter_from_cfn["ParameterValue"] + ")")
                different_stacksets.append(stackset)
                break

    # If there are no differences in templates/parameters, fail the build so
    # we don't need to approve/reject at the next step. Ideally, we'd stop the
    # pipeline with a success, but I haven't found a way to skip steps or bail
    # with success. So we bail with failure...
    if len(different_stacksets) == 0:
        jobId = event["CodePipeline.job"]["id"]
        code_pipeline.put_job_failure_result(
            jobId=jobId,
            failureDetails={
                "type": "JobFailed",
                "message": "All templates and parameters are the same. Nothing to deploy."
            }
        )

        return "All templates and parameters are the same. Nothing to deploy."

    differentMsg = ", ".join(different_message)
    differentMsg = "Approving this change will run the following stacksets: " + differentMsg

    outputVar = {
        "different": json.dumps(different_stacksets),
        "differentMsg": differentMsg
    }

    # If this lambda is being run as part of a pipeline, signal a "success"
    # so the pipeline can proceed to the next step
    if "CodePipeline.job" in event:
        jobId = event["CodePipeline.job"]["id"]
        code_pipeline.put_job_success_result(jobId=jobId, outputVariables=outputVar)

    return json.dumps(different_stacksets)
