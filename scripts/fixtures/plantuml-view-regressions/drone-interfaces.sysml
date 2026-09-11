package DjiDroneArchitecture {
  private import ScalarValues::Real;

  doc /* 教学用简化架构模型。显式最小假设：
   * 假设1：四旋翼布局（4 个电机、4 个电调、4 个螺旋桨）。
   * 假设2：典型消费级传感器配置，惯性（IMU）、气压计、磁罗盘集成于飞控内部。
   * 假设3：所有性能参数均为示例假设值，不使用大疆未公开的专有参数。
   */

  // ---------- 接口（端口）定义 ----------
  port def PwmSignalPort {
    doc /* 电机控制 PWM 信号接口。 */
    attribute dutyCycle : Real;
  }
  port def MotorDrivePort {
    doc /* 电调到电机的驱动接口。 */
  }
  port def PowerPort {
    doc /* 电源接口。 */
  }
  port def SensorDataPort {
    doc /* 惯性/气压/磁罗盘传感器数据接口。 */
  }
  port def GpsDataPort {
    doc /* GNSS 定位数据接口。 */
  }
  port def RcInputPort {
    doc /* 遥控指令输入接口。 */
  }
  port def TelemetryPort {
    doc /* 遥测接口。 */
  }
  port def GimbalControlPort {
    doc /* 云台控制接口。 */
  }

  // ---------- 子系统定义 ----------
  part def Frame {
    doc /* 机架（四旋翼布局，见最小假设1）。 */
  }
  part def Propeller;
  part def Motor {
    port driveIn : MotorDrivePort;
  }
  part def Esc {
    doc /* 电子调速器（ESC）。 */
    port cmdIn : PwmSignalPort;
    port powerIn : PowerPort;
    port driveOut : MotorDrivePort;
  }
  part def Battery {
    port powerOut : PowerPort;
  }
  part def PowerManagement {
    doc /* 电源管理模块。 */
    port batteryIn : PowerPort;
    port escPowerOut : PowerPort;
    port fcPowerOut : PowerPort;
  }
  part def GnssModule {
    doc /* GNSS 定位模块。 */
    port dataOut : GpsDataPort;
  }
  part def RcReceiver {
    doc /* 遥控接收机。 */
    port output : RcInputPort;
  }
  part def GimbalCamera {
    doc /* 云台相机。 */
    port controlIn : GimbalControlPort;
  }

  part def MainProcessor {
    doc /* 飞控主处理器。 */
    port imuIn : SensorDataPort;
    port baroIn : SensorDataPort;
    port magIn : SensorDataPort;
    port gnssBus : GpsDataPort;
    port rcBus : RcInputPort;
    port telemetryBus : TelemetryPort;
    port gimbalBus : GimbalControlPort;
    port pwmOut : PwmSignalPort;
    port powerIn : PowerPort;
  }
  part def Imu {
    port dataOut : SensorDataPort;
  }
  part def Barometer {
    port dataOut : SensorDataPort;
  }
  part def Magnetometer {
    port dataOut : SensorDataPort;
  }

  // ---------- 飞控内部组成与接口 ----------
  part def FlightController {
    doc /* 飞控：主处理器、IMU、气压计、磁罗盘集成于内部（最小假设2）。 */
    part mainProcessor : MainProcessor;
    part imu : Imu;
    part barometer : Barometer;
    part magnetometer : Magnetometer;

    port gnssIf : GpsDataPort;
    port motorControlOut : PwmSignalPort;
    port rcIn : RcInputPort;
    port telemetryIf : TelemetryPort;
    port gimbalControlIf : GimbalControlPort;
    port powerIn : PowerPort;

    connect imu.dataOut to mainProcessor.imuIn;
    connect barometer.dataOut to mainProcessor.baroIn;
    connect magnetometer.dataOut to mainProcessor.magIn;
    connect mainProcessor.gnssBus to gnssIf;
    connect mainProcessor.rcBus to rcIn;
    connect mainProcessor.telemetryBus to telemetryIf;
    connect mainProcessor.gimbalBus to gimbalControlIf;
    connect mainProcessor.pwmOut to motorControlOut;
    connect powerIn to mainProcessor.powerIn;
  }

  // ---------- 系统根：总体组成 ----------
  part def Drone {
    part 'frame' : Frame;
    part motors[4] : Motor;
    part escs[4] : Esc;
    part propellers[4] : Propeller;
    part battery : Battery;
    part powerManagement : PowerManagement;
    part flightController : FlightController;
    part gnssModule : GnssModule;
    part rcReceiver : RcReceiver;
    part gimbalCamera : GimbalCamera;

    // 有类型连接链：飞控 -> 电调 -> 电机（特征级连接，覆盖全部 4 组实例）
    connect flightController.motorControlOut to escs.cmdIn;
    connect escs.driveOut to motors.driveIn;

    // 飞控与 GNSS、遥控接收机、云台、电池（经电源管理）的接口关系
    connect gnssModule.dataOut to flightController.gnssIf;
    connect rcReceiver.output to flightController.rcIn;
    connect flightController.gimbalControlIf to gimbalCamera.controlIn;
    connect battery.powerOut to powerManagement.batteryIn;
    connect powerManagement.fcPowerOut to flightController.powerIn;
    connect powerManagement.escPowerOut to escs.powerIn;
  }

  // ---------- 控制时序：从起飞到落地 ----------
  action def DroneMissionSequence {
    doc /* 上电自检 -> 电机解锁(arm) -> 起飞爬升 -> 悬停/定点 -> 航线巡航 -> 返航 -> 下降着陆 -> 停桨(disarm)；不建模具体控制律（如 PID）。 */
    action powerOnSelfCheck;
    then action armMotors;
    then action takeoffClimb;
    then action hoverHold;
    then action routeCruise;
    then action returnToHome;
    then action descendAndLand;
    then action disarmMotors;
  }

  // ---------- 代表性需求（示例假设值，未验证） ----------
  requirement <'REQ-01'> endurance {
    doc /* 续航时间：在示例假设负载与飞行模式下，续航时间不小于 30 min（示例假设值）。 */
    subject drone : Drone;
  }
  requirement <'REQ-02'> maxAltitude {
    doc /* 最大飞行高度：不超过 500 m（示例假设值）。 */
    subject drone : Drone;
  }
  requirement <'REQ-03'> gpsPositioning {
    doc /* GPS 定位能力：GNSS 模块应提供满足示例假设精度要求的定位数据。 */
    subject gnss : GnssModule;
  }
  requirement <'REQ-04'> returnToHome {
    doc /* 失控返航（RTH）：遥控链路丢失后，飞控应自动执行返航。 */
    subject fc : FlightController;
  }
  requirement <'REQ-05'> stableHover {
    doc /* 稳定悬停：悬停位置偏差不超过示例假设限值。 */
    subject fc : FlightController;
  }
  requirement <'REQ-06'> safeTakeoffLanding {
    doc /* 起降安全：起飞与着陆过程应满足示例假设安全条件。 */
    subject airframe : Frame;
  }

  // ---------- 系统实例与需求追溯（satisfy 断言，不声称已验证） ----------
  part drone : Drone;

  satisfy endurance by drone;
  satisfy maxAltitude by drone;
  satisfy gpsPositioning by drone.gnssModule;
  satisfy returnToHome by drone.flightController;
  satisfy stableHover by drone.flightController;
  satisfy safeTakeoffLanding by drone.'frame';

  // ---------- 视图 ----------
  view requirementsView : StandardViewDefinitions::GeneralView {
    expose endurance;
    expose maxAltitude;
    expose gpsPositioning;
    expose returnToHome;
    expose stableHover;
    expose safeTakeoffLanding;
  }

  view architectureView : StandardViewDefinitions::GeneralView {
    expose Drone;
    expose drone;
    expose Frame;
    expose Motor;
    expose Esc;
    expose Propeller;
    expose Battery;
    expose PowerManagement;
    expose FlightController;
    expose GnssModule;
    expose RcReceiver;
    expose GimbalCamera;
  }

  view flightControllerInterfacesView : StandardViewDefinitions::InterconnectionView {
    expose Drone;
    expose FlightController;
  }

  view missionSequenceView : StandardViewDefinitions::ActionFlowView {
    expose DroneMissionSequence;
  }
}