#
# Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# MIT License

import boto3
import json
import requests

def add_priority(issue, priority):
    fields = issue["fields"]
    fields["priority"] = {"name": priority}

def add_assignee(issue, assignee):
    fields = issue["fields"]
    fields["assignee"] = {"name": assignee}

def add_due_date(issue, due_date):
    fields = issue["fields"]
    fields["duedate"] = due_date

def lookup(rid, resource_types):
    def lookup_for_tags(token):
        clientResourceGroupTag = boto3.client('resourcegroupstaggingapi')
        response = clientResourceGroupTag.get_resources(
            PaginationToken=token,
            ResourcesPerPage=100,
            ResourceTypeFilters=resource_types
        )
        return response
    total_results = []
    response = lookup_for_tags("")
    page_token = ""
    resourceInfo = ""
    while True:
        total_results += response["ResourceTagMappingList"]
        page_token = response["PaginationToken"]
        if page_token == "":
            break
        response = lookup_for_tags(page_token)

    for r in total_results:
        findResult = r["ResourceARN"].find(rid)
        if findResult != -1:
            resourceInfo +=  'The resource ARN '+r["ResourceARN"] + '\n'
            resourceInfo += '\nTags already applied to the resource: \n'
            for t in r["Tags"]:
                resourceInfo += 'Key:' + t['Key'] +  ' Value:' + t['Value'] + '\n'
    return resourceInfo

def handler(event, context):
    client = boto3.client("ssm")
    config_client = boto3.client('config')

    # Get the list of "resource types" this rule applies to
    config_rule_name = event["ConfigRuleName"].strip()
    config_rule = config_client.describe_config_rules(ConfigRuleNames=[config_rule_name])
    config_rule_resource_types = config_rule["ConfigRules"][0]["Scope"]["ComplianceResourceTypes"]
    resource_types = []

    # Resource not supported by "resource groups tagging"
    # see: https://docs.aws.amazon.com/cli/latest/reference/resourcegroupstaggingapi/index.html
    unsupported_resource_types = [
        "AWS::AutoScaling::AutoScalingGroup",
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
        "AWS::S3::Bucket"
    ]

    # Format the "resource type" notation that "AWS Config" notation uses to something
    # that "resource group tagging api" understands...
    # Ex: "AWS::EC2::Volume" to "ec2:volume"
    for config_rule_resource_type in config_rule_resource_types:
        # "AutoScaling" resource aren't supported by "resource groups tagging" it seems
        if config_rule_resource_type in unsupported_resource_types:
            continue

        resource_types.append(
            (config_rule_resource_type[5:]  # Remove assumed "AWS::" prefix
                .replace("::", ":")         # "::" to ":"
                .lower())                   # lowercase everything
        )

    ssm_parameter_name = event["SSMParameterName"].strip()

    secret = client.get_parameter(Name=ssm_parameter_name, WithDecryption=True)['Parameter']['Value']

    username = event["JiraUsername"].strip()
    url = event["JiraURL"].strip()
    resourceId = event["IssueDescription"].strip()

    resourceInfoDescrip = lookup(resourceId, resource_types)

    issue = {
        "fields": {
            "summary": event["IssueSummary"].strip() + '-' + resourceId,
            "project": {
                "key": event["ProjectKey"].strip()
            },
            "description": resourceInfoDescrip.strip(),
            "issuetype": {
                "name": event["IssueTypeName"].strip()
            }
        }
    }

    priority = event["PriorityName"].strip()
    if priority:
        add_priority(issue, priority)

    assignee = event["AssigneeName"].strip()
    if assignee:
        add_assignee(issue, assignee)

    due_date = event["DueDate"].strip()
    if due_date:
        add_due_date(issue, due_date)

    data = json.dumps(issue)

    headers = {'Content-Type':'application/json'}

    response = requests.post('{0}/rest/api/2/issue/'.format(url),
                             headers=headers,
                             data=data,
                             auth=(username, secret))

    if not response.ok:
        raise Exception("Received error with status code " + str(response.status_code) + " from Jira")
    else:
        issue_key = (response.json()["key"])
        return {"IssueKey": issue_key}
