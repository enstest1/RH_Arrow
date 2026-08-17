#!/usr/bin/env bash
# One-command launcher for a Robinhood Chain minting box in AWS Ohio (us-east-2).
# SAFETY: this uses YOUR existing AWS CLI login. It never contains or asks for keys.
# You authenticate once with `aws configure` or `aws sso login` BEFORE running this.
set -euo pipefail

REGION="us-east-2"                 # Ohio = closest to the RH sequencer. Fixed, not guessed.
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}"
NAME="rh-minter-ohio"
KEY_NAME="${KEY_NAME:-rh-minter-key}"

echo "==> Checking AWS CLI + login..."
if ! command -v aws >/dev/null; then
  echo "❌ AWS CLI not installed. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  exit 1
fi
if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  echo "❌ Not logged in to AWS. Run one of these first, then re-run me:"
  echo "     aws configure          (paste keys into the AWS CLI's own secure store — NOT into any chat)"
  echo "     aws sso login          (if your org uses SSO — preferred, no long-lived keys)"
  exit 1
fi
echo "   Logged in as: $(aws sts get-caller-identity --query Arn --output text)"

echo "==> Ensuring SSH key pair '$KEY_NAME' exists (Ohio)..."
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws ec2 create-key-pair --key-name "$KEY_NAME" --region "$REGION" \
    --query 'KeyMaterial' --output text > "${KEY_NAME}.pem"
  chmod 400 "${KEY_NAME}.pem"
  echo "   Created ${KEY_NAME}.pem (keep it safe — it's how you SSH in)."
else
  echo "   Key pair already exists. (Need the .pem? You saved it when first created.)"
fi

echo "==> Ensuring security group (SSH from YOUR IP only)..."
MYIP="$(curl -s https://checkip.amazonaws.com || echo '0.0.0.0')/32"
SG_ID="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values=rh-minter-sg \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(aws ec2 create-security-group --region "$REGION" \
    --group-name rh-minter-sg --description 'rh-minter SSH only' \
    --query 'GroupId' --output text)"
fi
# allow SSH from your current IP (idempotent; ignore if rule exists)
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "$MYIP" 2>/dev/null || true
echo "   SG $SG_ID allows SSH (port 22) from $MYIP only."

echo "==> Finding latest Ubuntu 22.04 AMI in $REGION..."
AMI="$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*' \
            'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
echo "   AMI: $AMI"

echo "==> Launching $INSTANCE_TYPE in $REGION..."
IID="$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" --security-group-ids "$SG_ID" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)"
echo "   Instance: $IID — waiting for it to boot..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

cat <<DONE

✅ Ohio box is up.
   Instance : $IID
   Public IP: $IP

Next:
  1) Copy the project up:
       scp -i ${KEY_NAME}.pem -r . ubuntu@${IP}:~/rh-minter
  2) SSH in:
       ssh -i ${KEY_NAME}.pem ubuntu@${IP}
  3) On the box: install Node, then set up .env and run the UI bound to localhost.
  4) View the dashboard safely via tunnel (from your laptop):
       ssh -i ${KEY_NAME}.pem -L 4663:localhost:4663 ubuntu@${IP}
     then open http://localhost:4663

WHEN DONE, stop paying:  ./deploy/terminate-ohio.sh
DONE
echo "$IID" > deploy/.last-instance
DONE
