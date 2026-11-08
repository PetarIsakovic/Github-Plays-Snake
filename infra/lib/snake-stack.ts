import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import type { Construct } from "constructs";

export interface SnakeStackProps extends StackProps {
  /** https://github.com/<user> visitors are redirected to after voting. */
  profileUrl: string;
  roundSeconds: number;
  boardCols: number;
  boardRows: number;
  votesPerIpPerRound: number;
  /** Hard cap on concurrent HTTP Lambda executions (cost + abuse ceiling). */
  httpConcurrency: number;
}

/**
 * Minimal serverless stack:
 *   DynamoDB (on-demand)  <-  HTTP Lambda (Function URL, public)  <-  GitHub Camo / visitors
 *                         <-  Tick Lambda   <-  EventBridge Scheduler (every minute)
 */
export class SnakeStack extends Stack {
  constructor(scope: Construct, id: string, props: SnakeStackProps) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN, // never lose the game/history on stack changes
    });

    const env = {
      TABLE_NAME: table.tableName,
      PROFILE_URL: props.profileUrl,
      ROUND_SECONDS: String(props.roundSeconds),
      BOARD_COLS: String(props.boardCols),
      BOARD_ROWS: String(props.boardRows),
      VOTES_PER_IP_PER_ROUND: String(props.votesPerIpPerRound),
      GAME_ID: "global",
      NODE_OPTIONS: "--enable-source-maps=false",
    };

    // Least privilege: exactly the item-level calls the repository makes, on this table only.
    const tablePolicy = new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
      resources: [table.tableArn],
    });

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      environment: env,
    } as const;

    const httpLogs = new logs.LogGroup(this, "HttpLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const httpFn = new lambda.Function(this, "HttpFn", {
      ...common,
      description: "GitHub Plays Snake: board.svg, votes, health",
      code: lambda.Code.fromAsset("dist/http"),
      memorySize: 512, // more CPU -> faster cold starts for Camo's short timeout
      timeout: Duration.seconds(8),
      reservedConcurrentExecutions: props.httpConcurrency,
      logGroup: httpLogs,
    });
    httpFn.addToRolePolicy(tablePolicy);

    const url = httpFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE, invokeMode: lambda.InvokeMode.BUFFERED });

    const tickLogs = new logs.LogGroup(this, "TickLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const tickFn = new lambda.Function(this, "TickFn", {
      ...common,
      description: "GitHub Plays Snake: scheduled round tick + IAM-only admin actions",
      code: lambda.Code.fromAsset("dist/tick"),
      memorySize: 256,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 2,
      logGroup: tickLogs,
    });
    tickFn.addToRolePolicy(tablePolicy);

    // Fires every minute; the function only advances the game when the round is due.
    new scheduler.Schedule(this, "TickSchedule", {
      description: "Advance GitHub Plays Snake when the current round is due",
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new targets.LambdaInvoke(tickFn, {
        input: scheduler.ScheduleTargetInput.fromObject({ action: "tick" }),
        retryAttempts: 2,
        maxEventAge: Duration.minutes(2),
      }),
    });

    // Visible in the CloudWatch console (no notification channel by default).
    new cloudwatch.Alarm(this, "TickErrors", {
      alarmDescription: "Tick Lambda is failing; the snake may be stuck",
      metric: tickFn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "HttpErrors", {
      alarmDescription: "HTTP Lambda errors or throttles",
      metric: new cloudwatch.MathExpression({
        expression: "e + t",
        usingMetrics: { e: httpFn.metricErrors({ period: Duration.minutes(5) }), t: httpFn.metricThrottles({ period: Duration.minutes(5) }) },
        period: Duration.minutes(5),
      }),
      threshold: 25,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // url.url is a deploy-time token that always ends with "/".
    new CfnOutput(this, "ServiceUrl", { value: url.url });
    new CfnOutput(this, "BoardSvgDark", { value: `${url.url}board.svg?theme=dark` });
    new CfnOutput(this, "VoteUrl", { value: `${url.url}vote?c=` });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "TickFunctionName", { value: tickFn.functionName });
  }
}
