#!/usr/bin/env bash
# Tears down the Ohio instance so you stop paying. Uses your existing AWS login.
set -euo pipefail
REGION="us-east-2"
if [ -f deploy/.last-instance ]; then
  IID="$(cat deploy/.last-instance)"
else
  read -rp "Instance ID to terminate: " IID
fi
echo "Terminating $IID in $REGION..."
aws ec2 terminate-instances --region "$REGION" --instance-ids "$IID" \
  --query 'TerminatingInstances[0].CurrentState.Name' --output text
echo "✅ Termination requested. Verify in the EC2 console that it's shutting down."
rm -f deploy/.last-instance
