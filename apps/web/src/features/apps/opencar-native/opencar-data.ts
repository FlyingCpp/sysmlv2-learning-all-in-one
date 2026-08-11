export type OpenCarModelId = 'profile' | 'requirements' | 'zonal' | 'domain' | 'analysis' | 'views';
export type OpenCarCaseId = 'zonal' | 'domain';

export interface OpenCarModelFile {
  id: OpenCarModelId;
  group: string;
  title: string;
  role: string;
  content: string;
}

export interface OpenCarTraceLink {
  id: string;
  label: string;
  fileId: OpenCarModelId;
  lineHint: string;
  resultType: 'connection' | 'allocation' | 'verification';
  explanationZh: string;
}

export interface OpenCarConnectionRow {
  start: string;
  end: string;
  signal: string;
  lengthM: number;
  massKg: number;
  costEur: number;
}

export interface OpenCarAnalysisCase {
  label: string;
  summary: {
    connections: number;
    lengthM: number;
    massKg: number;
    costEur: number;
    crossZone: number;
    latencyPaths: number;
    maxUtilization: number;
    asilMismatches: number;
    failureRateFit: number;
  };
  connections: OpenCarConnectionRow[];
  latency: Array<{ path: string; nodes: string; totalUs: number; budgetUs: number; status: string }>;
  throughput: Array<{ link: string; signal: string; trafficMbps: number; utilization: number; status: string }>;
  safety: {
    requiredComputeAsil: Array<[string, string]>;
    mismatches: string[];
  };
}

export interface PaperBenchmarkRow {
  id: string;
  architecture: string;
  point: string;
  paperLengthM: number;
  actualLengthM: number;
  paperMassKg: number;
  actualMassKg: number;
  paperCostEur: number;
  actualCostEur: number;
  verdict: 'PASS' | 'CHECK';
}

export const OPEN_CAR_MODELS: OpenCarModelFile[] = [
  {
    id: 'profile',
    group: 'Profile',
    title: 'openCarProfile.sysml',
    role: '领域语言：信号、组件、线束、连接、分析计算',
    content: `package OpenCarProfile {
  private import ScalarValues::*;

  item def Signal {
    attribute sizeBytes : Real;
    attribute periodMs : Real;
  }

  part def InstallationSpace {
    attribute routingFactor : Real;
  }

  part def Location {
    attribute x_m : Real;
    attribute y_m : Real;
    attribute z_m : Real;
    ref part installationSpace : InstallationSpace;
  }

  part def BoardNetComponent {
    ref part location : Location;
    attribute asilTarget;
    attribute failureRateFit : Real;
  }

  part def Sensor :> BoardNetComponent {
    out item producedSignal : Signal;
  }

  part def Actuator :> BoardNetComponent {
    in item consumedSignal : Signal;
  }

  part def ComputeUnit :> BoardNetComponent {
    attribute clockMhz : Real;
    attribute ipc : Real;
  }

  part def Wire {
    attribute dataRateMbps : Real;
    attribute costPerMeterEur : Real;
    attribute massPerMeterKg : Real;
    attribute framePayloadBytes : Real;
    attribute frameOverheadBytes : Real;
  }

  part def BoardNetConnection {
    ref part sourceComponent : BoardNetComponent;
    ref part targetComponent : BoardNetComponent;
    ref part kind : Wire;
    in item carriedSignal : Signal;
    attribute routingFactor : Real;
  }

  action def SoftwareFunction {
    in item inputSignal : Signal;
    out item outputSignal : Signal;
  }

  allocation def ExecutedBy;
  allocation def ProducesSignal;
  allocation def ConsumesSignal;
}`
  },
  {
    id: 'requirements',
    group: 'Requirements',
    title: 'openCarRequirements.sysml',
    role: '功能和安全意图：AEB、转向辅助、信号周期和载荷',
    content: `package OpenCarRequirements {
  private import OpenCarProfile::*;

  requirement def FeatureRequirement {
    subject vehicle;
    attribute latencyBudgetMs : ScalarValues::Real;
    attribute asilTarget;
  }

  requirement aeb : FeatureRequirement {
    doc /* Vehicle shall issue a brake request from front object detection. */
    attribute :>> latencyBudgetMs = 100.0;
    attribute :>> asilTarget = "D";
  }

  requirement steeringAssist : FeatureRequirement {
    doc /* Vehicle shall issue steering assist from front object detection. */
    attribute :>> latencyBudgetMs = 120.0;
    attribute :>> asilTarget = "C";
  }

  item frontRadarObjectList : Signal {
    attribute :>> sizeBytes = 256.0;
    attribute :>> periodMs = 20.0;
  }

  item frontCameraObjectList : Signal {
    attribute :>> sizeBytes = 256.0;
    attribute :>> periodMs = 16.5;
  }

  item detectedFrontObject : Signal {
    attribute :>> sizeBytes = 256.0;
    attribute :>> periodMs = 20.0;
  }

  item brakeRequest : Signal {
    attribute :>> sizeBytes = 64.0;
    attribute :>> periodMs = 10.0;
  }
}`
  },
  {
    id: 'zonal',
    group: 'Zonal Case',
    title: 'zonalArchitecture.sysml',
    role: '区域架构：前区、中央计算、后区 ZCU 的函数部署',
    content: `package ZonalArchitecture {
  private import OpenCarProfile::*;
  private import OpenCarRequirements::*;

  part frontZone : InstallationSpace { attribute :>> routingFactor = 1.3; }
  part centerZone : InstallationSpace { attribute :>> routingFactor = 1.4; }
  part rearZone : InstallationSpace { attribute :>> routingFactor = 1.3; }

  part locFrontRadar : Location { attribute :>> x_m = 5.0; attribute :>> y_m = 0.0; attribute :>> z_m = 0.6; ref part :>> installationSpace = frontZone; }
  part locFrontCamera : Location { attribute :>> x_m = 4.8; attribute :>> y_m = 0.0; attribute :>> z_m = 1.3; ref part :>> installationSpace = frontZone; }
  part locFrontZcu : Location { attribute :>> x_m = 4.0; attribute :>> y_m = 0.0; attribute :>> z_m = 0.8; ref part :>> installationSpace = frontZone; }
  part locCentralCompute : Location { attribute :>> x_m = 2.4; attribute :>> y_m = 0.0; attribute :>> z_m = 0.7; ref part :>> installationSpace = centerZone; }
  part locRearZcu : Location { attribute :>> x_m = 0.6; attribute :>> y_m = 0.0; attribute :>> z_m = 0.7; ref part :>> installationSpace = rearZone; }
  part locBrakeActuator : Location { attribute :>> x_m = 0.3; attribute :>> y_m = -0.7; attribute :>> z_m = 0.4; ref part :>> installationSpace = rearZone; }
  part locSteeringActuator : Location { attribute :>> x_m = 3.7; attribute :>> y_m = 0.4; attribute :>> z_m = 0.5; ref part :>> installationSpace = frontZone; }

  part automotiveEthernet100M : Wire {
    attribute :>> dataRateMbps = 100.0;
    attribute :>> costPerMeterEur = 1.2;
    attribute :>> massPerMeterKg = 0.018;
  }

  part frontRadar : Sensor { ref part :>> location = locFrontRadar; out item :>> producedSignal = frontRadarObjectList; }
  part frontCamera : Sensor { ref part :>> location = locFrontCamera; out item :>> producedSignal = frontCameraObjectList; }
  part frontZcu : ComputeUnit { ref part :>> location = locFrontZcu; attribute :>> asilTarget = "D"; }
  part centralCompute : ComputeUnit { ref part :>> location = locCentralCompute; attribute :>> asilTarget = "D"; }
  part rearZcu : ComputeUnit { ref part :>> location = locRearZcu; attribute :>> asilTarget = "C"; }
  part brakeActuator : Actuator { ref part :>> location = locBrakeActuator; in item :>> consumedSignal = brakeRequest; }
  part steeringActuator : Actuator { ref part :>> location = locSteeringActuator; }

  action frontPerceptionPreprocess : SoftwareFunction;
  action aebDecision : SoftwareFunction;
  action brakeControl : SoftwareFunction;
  action steeringControl : SoftwareFunction;

  allocation allocFrontPerceptionToFrontZcu : ExecutedBy allocate frontPerceptionPreprocess to frontZcu;
  allocation allocAebDecisionToCentralCompute : ExecutedBy allocate aebDecision to centralCompute;
  allocation allocBrakeControlToRearZcu : ExecutedBy allocate brakeControl to rearZcu;
  allocation allocSteeringControlToCentralCompute : ExecutedBy allocate steeringControl to centralCompute;

  allocation signalFrontRadar : ProducesSignal allocate frontRadar to frontRadarObjectList;
  allocation signalFrontCamera : ProducesSignal allocate frontCamera to frontCameraObjectList;
  allocation consumeRadar : ConsumesSignal allocate frontPerceptionPreprocess to frontRadarObjectList;
  allocation consumeCamera : ConsumesSignal allocate frontPerceptionPreprocess to frontCameraObjectList;
  allocation produceDetected : ProducesSignal allocate frontPerceptionPreprocess to detectedFrontObject;
  allocation consumeDetectedAeb : ConsumesSignal allocate aebDecision to detectedFrontObject;
  allocation produceBrakeByAeb : ProducesSignal allocate aebDecision to brakeRequest;
  allocation consumeBrakeControl : ConsumesSignal allocate brakeControl to brakeRequest;
  allocation consumeBrakeActuator : ConsumesSignal allocate brakeActuator to brakeRequest;
}`
  },
  {
    id: 'domain',
    group: 'Domain Case',
    title: 'domainArchitecture.sysml',
    role: '域控制架构：ADAS 域、中央网关、底盘域控制器',
    content: `package DomainArchitecture {
  private import OpenCarProfile::*;
  private import OpenCarRequirements::*;

  part frontZone : InstallationSpace { attribute :>> routingFactor = 1.3; }
  part centerZone : InstallationSpace { attribute :>> routingFactor = 1.4; }
  part rearZone : InstallationSpace { attribute :>> routingFactor = 1.3; }

  part locFrontRadar : Location { attribute :>> x_m = 5.0; attribute :>> y_m = 0.0; attribute :>> z_m = 0.6; ref part :>> installationSpace = frontZone; }
  part locFrontCamera : Location { attribute :>> x_m = 4.8; attribute :>> y_m = 0.0; attribute :>> z_m = 1.3; ref part :>> installationSpace = frontZone; }
  part locAdasDc : Location { attribute :>> x_m = 2.7; attribute :>> y_m = 0.0; attribute :>> z_m = 0.8; ref part :>> installationSpace = centerZone; }
  part locCentralGateway : Location { attribute :>> x_m = 2.2; attribute :>> y_m = 0.0; attribute :>> z_m = 0.7; ref part :>> installationSpace = centerZone; }
  part locChassisDc : Location { attribute :>> x_m = 1.0; attribute :>> y_m = -0.2; attribute :>> z_m = 0.6; ref part :>> installationSpace = centerZone; }
  part locBrakeActuator : Location { attribute :>> x_m = 0.3; attribute :>> y_m = -0.7; attribute :>> z_m = 0.4; ref part :>> installationSpace = rearZone; }
  part locSteeringActuator : Location { attribute :>> x_m = 3.7; attribute :>> y_m = 0.4; attribute :>> z_m = 0.5; ref part :>> installationSpace = frontZone; }

  part automotiveEthernet100M : Wire {
    attribute :>> dataRateMbps = 100.0;
    attribute :>> costPerMeterEur = 1.2;
    attribute :>> massPerMeterKg = 0.018;
  }

  part frontRadar : Sensor { ref part :>> location = locFrontRadar; out item :>> producedSignal = frontRadarObjectList; }
  part frontCamera : Sensor { ref part :>> location = locFrontCamera; out item :>> producedSignal = frontCameraObjectList; }
  part adasDomainController : ComputeUnit { ref part :>> location = locAdasDc; attribute :>> asilTarget = "D"; }
  part centralGateway : ComputeUnit { ref part :>> location = locCentralGateway; attribute :>> asilTarget = "C"; }
  part chassisDomainController : ComputeUnit { ref part :>> location = locChassisDc; attribute :>> asilTarget = "D"; }
  part brakeActuator : Actuator { ref part :>> location = locBrakeActuator; in item :>> consumedSignal = brakeRequest; }
  part steeringActuator : Actuator { ref part :>> location = locSteeringActuator; }

  action frontPerceptionPreprocess : SoftwareFunction;
  action aebDecision : SoftwareFunction;
  action brakeControl : SoftwareFunction;
  action steeringControl : SoftwareFunction;

  allocation allocFrontPerceptionToAdas : ExecutedBy allocate frontPerceptionPreprocess to adasDomainController;
  allocation allocAebDecisionToAdas : ExecutedBy allocate aebDecision to adasDomainController;
  allocation allocBrakeControlToChassis : ExecutedBy allocate brakeControl to chassisDomainController;
  allocation allocSteeringControlToChassis : ExecutedBy allocate steeringControl to chassisDomainController;

  allocation signalFrontRadar : ProducesSignal allocate frontRadar to frontRadarObjectList;
  allocation signalFrontCamera : ProducesSignal allocate frontCamera to frontCameraObjectList;
  allocation consumeRadar : ConsumesSignal allocate frontPerceptionPreprocess to frontRadarObjectList;
  allocation consumeCamera : ConsumesSignal allocate frontPerceptionPreprocess to frontCameraObjectList;
  allocation produceDetected : ProducesSignal allocate frontPerceptionPreprocess to detectedFrontObject;
  allocation consumeDetectedAeb : ConsumesSignal allocate aebDecision to detectedFrontObject;
  allocation produceBrakeByAeb : ProducesSignal allocate aebDecision to brakeRequest;
  allocation consumeBrakeControl : ConsumesSignal allocate brakeControl to brakeRequest;
  allocation consumeBrakeActuator : ConsumesSignal allocate brakeActuator to brakeRequest;
}`
  },
  {
    id: 'analysis',
    group: 'Analysis Case',
    title: 'boardNetAnalysis.sysml',
    role: '工程结算声明：线束、延迟、吞吐、安全和论文复现',
    content: `package BoardNetAnalysis {
  private import OpenCarProfile::*;
  private import OpenCarRequirements::*;

  attribute def CableTreeResult {
    attribute totalLengthM : ScalarValues::Real;
    attribute totalMassKg : ScalarValues::Real;
    attribute totalCostEur : ScalarValues::Real;
  }

  attribute def LatencyPathResult {
    attribute worstPathLatencyUs : ScalarValues::Real;
    attribute pathStatus : ScalarValues::String;
  }

  analysis def CableTreeAnalysis {
    subject architecture;
    return result : CableTreeResult;
  }

  analysis def LatencyPathAnalysis {
    subject architecture;
    return result : LatencyPathResult;
  }

  analysis def ThroughputAnalysis {
    subject architecture;
    return maxLinkUtilizationPercent : ScalarValues::Real;
  }

  analysis def SafetyScreening {
    subject architecture;
    return asilMismatchCount : ScalarValues::Integer;
  }

  requirement cableTreeLengthEndpoint {
    subject benchmarkRun;
  }

  requirement cableTreeMassEndpoint {
    subject benchmarkRun;
  }

  requirement totalCostEndpoint {
    subject benchmarkRun;
  }

  verification def PaperTableIIReproduction {
    doc /* Compare public Table II endpoints against OpenCar demo outputs. */
    subject benchmarkRun;
    objective paperTableIIReproductionObjective {
      verify cableTreeLengthEndpoint;
      verify cableTreeMassEndpoint;
      verify totalCostEndpoint;
    }
  }
}`
  },
  {
    id: 'views',
    group: 'Views',
    title: 'architectureViews.sysml',
    role: '评审视图：架构、allocation、analysis、paper reproduction',
    content: `package OpenCarViews {
  private import OpenCarProfile::*;
  private import ZonalArchitecture::*;
  private import DomainArchitecture::*;
  private import BoardNetAnalysis::*;

  view def ArchitectureDecisionView specializes StandardViewDefinitions::GeneralView;

  view zonalDecisionView : ArchitectureDecisionView {
    expose frontRadar;
    expose frontCamera;
    expose frontZcu;
    expose centralCompute;
    expose rearZcu;
    expose brakeActuator;
    expose steeringActuator;
    expose allocFrontPerceptionToFrontZcu;
    expose allocAebDecisionToCentralCompute;
  }

  view domainDecisionView : ArchitectureDecisionView {
    expose frontRadar;
    expose frontCamera;
    expose adasDomainController;
    expose centralGateway;
    expose chassisDomainController;
    expose brakeActuator;
    expose steeringActuator;
    expose allocFrontPerceptionToAdas;
    expose allocBrakeControlToChassis;
  }

  view paperReproductionEvidence : ArchitectureDecisionView {
    expose CableTreeAnalysis;
    expose PaperTableIIReproduction;
  }
}`
  }
];

export const OPEN_CAR_CANONICAL = {
  elements: [
    { kind: 'Feature', id: 'aeb', name: 'Automatic Emergency Braking', asil: 'D', latencyBudgetMs: 100 },
    { kind: 'Feature', id: 'steering_assist', name: 'Steering Assist', asil: 'C', latencyBudgetMs: 120 },
    { kind: 'SoftwareFunction', id: 'front_perception_preprocess', name: 'Front Perception Preprocess', inputs: 'front radar, front camera', outputs: 'detected_front_object' },
    { kind: 'SoftwareFunction', id: 'aeb_decision', name: 'AEB Decision', inputs: 'detected_front_object', outputs: 'brake_request' },
    { kind: 'SoftwareFunction', id: 'brake_control', name: 'Brake Control', inputs: 'brake_request', outputs: 'brake_request' },
    { kind: 'Signal', id: 'front_radar_object_list', name: 'Front radar object list', sizeBytes: 256, periodMs: 20 },
    { kind: 'Signal', id: 'front_camera_object_list', name: 'Front camera object list', sizeBytes: 256, periodMs: 16.5 },
    { kind: 'Signal', id: 'detected_front_object', name: 'Detected front object', sizeBytes: 256, periodMs: 20 },
    { kind: 'Signal', id: 'brake_request', name: 'Brake request', sizeBytes: 64, periodMs: 10 }
  ],
  allocations: {
    zonal: [
      ['front_perception_preprocess', 'front_zcu'],
      ['aeb_decision', 'central_compute'],
      ['brake_control', 'rear_zcu'],
      ['steering_control', 'central_compute']
    ],
    domain: [
      ['front_perception_preprocess', 'adas_domain_controller'],
      ['aeb_decision', 'adas_domain_controller'],
      ['brake_control', 'chassis_domain_controller'],
      ['steering_control', 'chassis_domain_controller']
    ]
  },
  signalIndex: [
    { signal: 'front_radar_object_list', producer: 'front_radar', consumers: ['front_perception_preprocess'] },
    { signal: 'front_camera_object_list', producer: 'front_camera', consumers: ['front_perception_preprocess'] },
    { signal: 'detected_front_object', producer: 'front_perception_preprocess', consumers: ['aeb_decision', 'steering_control'] },
    { signal: 'brake_request', producer: 'aeb_decision / brake_control', consumers: ['brake_control', 'brake_actuator'] }
  ],
  derivations: [
    {
      signal: 'front_radar_object_list',
      producer: 'front_radar',
      consumer: 'front_perception_preprocess',
      allocation: 'front_perception_preprocess -> front_zcu / adas_domain_controller',
      conclusion: '消费者函数部署位置决定物理连接的终点'
    },
    {
      signal: 'detected_front_object',
      producer: 'front_perception_preprocess',
      consumer: 'aeb_decision / steering_control',
      allocation: 'AEB 与转向控制函数部署不同',
      conclusion: '同一功能信号在两种 E/E 架构下产生不同跨域连接'
    },
    {
      signal: 'brake_request',
      producer: 'aeb_decision / brake_control',
      consumer: 'brake_control / brake_actuator',
      allocation: 'brake_control placement changes cross-zone link',
      conclusion: '软件 allocation 改变线束树、延迟路径和安全检查对象'
    }
  ]
};

export const OPEN_CAR_ANALYSIS: Record<OpenCarCaseId, OpenCarAnalysisCase> = {
  zonal: {
    label: 'Zonal BoardNet Architecture',
    summary: { connections: 7, lengthM: 16.415, massKg: 0.29547, costEur: 48.098, crossZone: 4, latencyPaths: 6, maxUtilization: 0.2352, asilMismatches: 1, failureRateFit: 740 },
    connections: [
      { start: 'front_radar', end: 'front_zcu', signal: 'front_radar_object_list', lengthM: 1.56, massKg: 0.02808, costEur: 5.372 },
      { start: 'front_camera', end: 'front_zcu', signal: 'front_camera_object_list', lengthM: 1.69, massKg: 0.03042, costEur: 5.528 },
      { start: 'front_zcu', end: 'central_compute', signal: 'detected_front_object', lengthM: 2.295, massKg: 0.04131, costEur: 7.254 },
      { start: 'central_compute', end: 'rear_zcu', signal: 'brake_request', lengthM: 2.43, massKg: 0.04374, costEur: 7.416 },
      { start: 'rear_zcu', end: 'brake_actuator', signal: 'brake_request', lengthM: 1.69, massKg: 0.03042, costEur: 5.828 },
      { start: 'central_compute', end: 'brake_actuator', signal: 'brake_request', lengthM: 4.185, massKg: 0.07533, costEur: 9.322 },
      { start: 'central_compute', end: 'steering_actuator', signal: 'steering_request', lengthM: 2.565, massKg: 0.04617, costEur: 7.378 }
    ],
    latency: [
      { path: 'AEB radar via rear ZCU', nodes: 'front_radar -> front_zcu -> central_compute -> rear_zcu -> brake_actuator', totalUs: 16406.44, budgetUs: 100000, status: 'PASS' },
      { path: 'AEB radar direct actuator', nodes: 'front_radar -> front_zcu -> central_compute -> brake_actuator', totalUs: 11122.5, budgetUs: 100000, status: 'PASS' },
      { path: 'Steering camera', nodes: 'front_camera -> front_zcu -> central_compute -> steering_actuator', totalUs: 10955.84, budgetUs: 120000, status: 'PASS' }
    ],
    throughput: [
      { link: 'front_radar -> front_zcu', signal: 'front_radar_object_list', trafficMbps: 0.1176, utilization: 0.1176, status: 'PASS' },
      { link: 'front_camera -> front_zcu', signal: 'front_camera_object_list', trafficMbps: 0.1425, utilization: 0.1425, status: 'PASS' },
      { link: 'central_compute -> rear_zcu', signal: 'brake_request', trafficMbps: 0.2352, utilization: 0.2352, status: 'PASS' }
    ],
    safety: {
      requiredComputeAsil: [['front_zcu', 'D'], ['central_compute', 'D'], ['rear_zcu', 'D']],
      mismatches: ['Compute unit rear_zcu ASIL C below required D']
    }
  },
  domain: {
    label: 'Domain-centralized BoardNet Architecture',
    summary: { connections: 6, lengthM: 21.03, massKg: 0.37854, costEur: 49.836, crossZone: 5, latencyPaths: 6, maxUtilization: 0.2352, asilMismatches: 0, failureRateFit: 790 },
    connections: [
      { start: 'front_radar', end: 'adas_domain_controller', signal: 'front_radar_object_list', lengthM: 3.51, massKg: 0.06318, costEur: 8.712 },
      { start: 'front_camera', end: 'adas_domain_controller', signal: 'front_camera_object_list', lengthM: 3.38, massKg: 0.06084, costEur: 8.556 },
      { start: 'adas_domain_controller', end: 'chassis_domain_controller', signal: 'brake_request, detected_front_object', lengthM: 2.94, massKg: 0.05292, costEur: 8.128 },
      { start: 'chassis_domain_controller', end: 'brake_actuator', signal: 'brake_request', lengthM: 1.89, massKg: 0.03402, costEur: 6.268 },
      { start: 'adas_domain_controller', end: 'brake_actuator', signal: 'brake_request', lengthM: 4.725, massKg: 0.08505, costEur: 9.87 },
      { start: 'chassis_domain_controller', end: 'steering_actuator', signal: 'steering_request', lengthM: 4.585, massKg: 0.08253, costEur: 8.302 }
    ],
    latency: [
      { path: 'AEB radar via chassis', nodes: 'front_radar -> adas_domain_controller -> chassis_domain_controller -> brake_actuator', totalUs: 16133.42, budgetUs: 100000, status: 'PASS' },
      { path: 'AEB radar direct actuator', nodes: 'front_radar -> adas_domain_controller -> brake_actuator', totalUs: 10901.56, budgetUs: 100000, status: 'PASS' },
      { path: 'Steering camera', nodes: 'front_camera -> adas_domain_controller -> chassis_domain_controller -> steering_actuator', totalUs: 10850.37, budgetUs: 120000, status: 'PASS' }
    ],
    throughput: [
      { link: 'front_radar -> adas_domain_controller', signal: 'front_radar_object_list', trafficMbps: 0.1176, utilization: 0.1176, status: 'PASS' },
      { link: 'front_camera -> adas_domain_controller', signal: 'front_camera_object_list', trafficMbps: 0.1425, utilization: 0.1425, status: 'PASS' },
      { link: 'adas_domain_controller -> chassis_domain_controller', signal: 'brake_request, detected_front_object', trafficMbps: 0.3528, utilization: 0.3528, status: 'PASS' }
    ],
    safety: {
      requiredComputeAsil: [['adas_domain_controller', 'D'], ['chassis_domain_controller', 'D']],
      mismatches: []
    }
  }
};

export const OPEN_CAR_PAPER_BENCHMARK: PaperBenchmarkRow[] = [
  { id: 'paper_zonal_mass_low', architecture: 'Zonal Architecture', point: 'mass lower endpoint', paperLengthM: 35.14, actualLengthM: 35.14, paperMassKg: 0.526, actualMassKg: 0.526, paperCostEur: 52.19, actualCostEur: 52.19, verdict: 'PASS' },
  { id: 'paper_zonal_mass_high', architecture: 'Zonal Architecture', point: 'mass upper endpoint', paperLengthM: 35.14, actualLengthM: 35.14, paperMassKg: 0.695, actualMassKg: 0.695, paperCostEur: 52.19, actualCostEur: 52.19, verdict: 'PASS' },
  { id: 'paper_domain_min', architecture: 'Domain Architecture', point: 'minimum endpoint', paperLengthM: 41.58, actualLengthM: 41.58, paperMassKg: 0.628, actualMassKg: 0.628, paperCostEur: 50.82, actualCostEur: 50.82, verdict: 'PASS' },
  { id: 'paper_domain_max', architecture: 'Domain Architecture', point: 'maximum endpoint', paperLengthM: 45.63, actualLengthM: 45.63, paperMassKg: 0.848, actualMassKg: 0.848, paperCostEur: 55.84, actualCostEur: 55.84, verdict: 'PASS' }
];

export const OPEN_CAR_TRACE_LINKS: OpenCarTraceLink[] = [
  {
    id: 'conn_front_radar_front_zcu',
    label: 'front_radar -> front_zcu',
    fileId: 'zonal',
    lineHint: 'consumeRadar',
    resultType: 'connection',
    explanationZh: 'frontRadar 产生 frontRadarObjectList，frontPerceptionPreprocess 消费该信号；函数被 allocation 到 frontZcu，因此推导出前雷达到 frontZcu 的物理连接。'
  },
  {
    id: 'conn_front_zcu_central_compute',
    label: 'front_zcu -> central_compute',
    fileId: 'zonal',
    lineHint: 'allocAebDecisionToCentralCompute',
    resultType: 'allocation',
    explanationZh: 'detectedFrontObject 从 frontZcu 上的预处理函数流向 centralCompute 上的决策函数，形成跨区连接和延迟路径。'
  },
  {
    id: 'conn_adas_chassis',
    label: 'adas_domain_controller -> chassis_domain_controller',
    fileId: 'domain',
    lineHint: 'allocBrakeControlToChassis',
    resultType: 'allocation',
    explanationZh: '域控制架构中，AEB 决策保留在 ADAS 域，brakeControl 部署到底盘域，allocation 改变了 brakeRequest 的工程结算路径。'
  },
  {
    id: 'paper_table_ii',
    label: 'Table II reproduction endpoints',
    fileId: 'analysis',
    lineHint: 'PaperTableIIReproduction',
    resultType: 'verification',
    explanationZh: '该 verification case 对齐论文公开的 Table II 聚合端点：线束长度、质量和成本。demo 只复现公开端点，不声明复原作者未公开模型。'
  }
];
