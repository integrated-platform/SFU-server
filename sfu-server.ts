// SFU Server (Port 8500)
import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { Kafka } from 'kafkajs';
// import { WebRTCRoomManager } from './WebRTCRoomManager'; // 실제 SFU 미디어 로직 관리자

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Kafka 설정
const kafka = new Kafka({
  clientId: 'sfu-server',
  brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
});
const kafkaConsumer = kafka.consumer({ groupId: 'sfu-group' });
const kafkaProducer = kafka.producer();

// -------------------------------
// 방/참가자 관리 및 Kafka 핸들러
// -------------------------------
interface UserInfo {
  userName: string;
  email: string;
  auth: string;
  environmentReady: boolean;
  socketId: string;
}

const roomUsers: Record<string, UserInfo[]> = {}; // roomId → UserInfo[]
// const roomManager = new WebRTCRoomManager(io, kafkaProducer); // 실제 WebRTC 미디어 세션 관리

const handleCommand = async (command: any) => {
  switch (command.type) {
    case 'joinRoom':
      console.log(`SFU: ${command.user.userName} joined room ${command.roomId}`);
      // 1. 내부 상태 업데이트
      const newUser: UserInfo = { ...command.user, environmentReady: false, socketId: command.socketId };
      roomUsers[command.roomId] ??= [];
      roomUsers[command.roomId].push(newUser);
      // 2. 실제 미디어 연결 로직 (WebRTCRoomManager.handleJoin(command))
      // 3. (Optional) 해당 방에 사용자 참가 알림 브로드캐스트
      break;

    case 'disconnect':
      console.log(`SFU: User disconnected ${command.socketId}`);
      // 1. 내부 상태 업데이트
      for (const roomId in roomUsers) {
        roomUsers[roomId] = roomUsers[roomId].filter((u) => u.socketId !== command.socketId);
      }
      // 2. 실제 미디어 연결 해제 로직 (WebRTCRoomManager.handleDisconnect(command))
      break;

    case 'environmentReady': // 시그널링 서버로부터 환경 준비 완료 명령 수신 (개선된 로직)
      console.log(`SFU: ${command.user.userName} is ready in room ${command.roomId}`);
      // 1. 내부 상태 업데이트 (SFU에 연결된 소켓이 아니더라도 Kafka를 통해 상태를 갱신)
      const userToUpdate = roomUsers[command.roomId]?.find(u => u.email === command.user.email);
      if (userToUpdate) userToUpdate.environmentReady = true;
      break;

    case 'startTest':
      console.log(`SFU: Test started in room ${command.roomId}`);
      // 1. 실제 미디어 연결 수립 시작 로직 (WebRTCRoomManager.handleStartTest(command))
      // 2. 필요시 Kafka 피드백 전송 (sfu_feedback)
      break;
      
    default:
      console.log('SFU: Unknown command', command);
  }
};

(async () => {
  await kafkaConsumer.connect();
  await kafkaProducer.connect();
  // 시그널링 서버로부터 명령 수신 (Commands)
  await kafkaConsumer.subscribe({ topic: 'sfu_commands', fromBeginning: false });

  await kafkaConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const command = JSON.parse(message.value.toString());
      await handleCommand(command);
    },
  });

  console.log('✅ SFU Kafka consumer running');
})();

// -------------------------------
// Socket.IO 연결 (WebRTC 시그널링 전담)
// -------------------------------
io.on('connection', (socket: Socket) => {
  console.log('SFU connected (for signaling):', socket.id);

  // 클라이언트가 SFU의 방에 참가
  socket.on('join-sfu-room', (data: { roomId: string }) => {
    socket.join(data.roomId);
    console.log(`SFU Signaling: ${socket.id} joined ${data.roomId}`);
    // WebRTC 연결 수립에 필요한 정보 전송 (e.g., ICE 서버 설정)
  });

  // -------------------------------
  // WebRTC 시그널링 (클라이언트 <-> SFU)
  // -------------------------------
  socket.on('relay-offer', (data) => {
    // SFU가 클라이언트에게 받은 Offer를 SFU 내부의 WebRTC 모듈로 전달해야 함.
    // 현재는 간단히 다른 피어에게 중계하는 형태로 구현. 실제로는 SFU의 코어 모듈로 전달됨.
    console.log(`SFU Signaling: Offer from ${socket.id} in room ${data.room}`);
    // socket.to(data.room).emit('relay-offer', { sender: socket.id, offer: data.offer });
  });

  socket.on('relay-answer', (data) =>
    socket.to(data.room).emit('relay-answer', { sender: socket.id, answer: data.answer }),
  );
  
  socket.on('relay-candidate', (data) =>
    socket.to(data.room).emit('relay-candidate', { sender: socket.id, candidate: data.candidate }),
  );

  // -------------------------------
  // Socket disconnect (SFU Signaling Socket만 끊어진 경우)
  // -------------------------------
  socket.on('disconnect', () => {
    console.log('SFU signaling socket disconnected:', socket.id);
    // 미디어 세션 종료 처리 (roomManager.handleSFUSocketDisconnect(socket.id))
  });
});


// -------------------------------
// 서버 실행
// -------------------------------
server.listen(process.env.SFU_PORT || 8500, () => console.log(`🚀 SFU 서버 실행 중`));