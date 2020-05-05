import boto3
import os

s3 = boto3.resource("s3")
s3_client = boto3.client("s3")
code_pipeline = boto3.client("codepipeline")

def lambda_handler(event, context):
    bucket_name = os.environ['BucketName']
    bucket = s3.Bucket(bucket_name)

    objects_to_delete = []

    for p in s3_client.get_paginator("list_objects_v2").paginate(Bucket=bucket_name, Prefix="cf-stacks"):
        if "Contents" in p:
            for e in p["Contents"]:
                objects_to_delete.append({
                    "Key": e["Key"]
                })

    if len(objects_to_delete) > 0:
        bucket.delete_objects(Delete={
            "Objects": objects_to_delete
        })

    # If this lambda is being run as part of a pipeline, signal a "success"
    # so the pipeline can proceed to the next step
    if "CodePipeline.job" in event:
        jobId = event["CodePipeline.job"]["id"]
        code_pipeline.put_job_success_result(jobId=jobId)
