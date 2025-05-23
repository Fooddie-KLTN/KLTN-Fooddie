/* eslint-disable prettier/prettier */
import { Controller,  UnauthorizedException,  UseGuards, Request } from '@nestjs/common';
import { UsersService } from './users.service';
import { Post, Body, Get, Param, Put, Delete, Req } from '@nestjs/common';
import { CreateUserDto } from './dto/create-users.dto';
import { UpdateUserDto } from './dto/update-users.dto';
import { Permission } from 'src/constants/permission.enum';
import { Permissions } from 'src/common/decorator/permissions.decorator';
import { User } from 'src/entities/user.entity';
import { RolesGuard } from 'src/common/guard/role.guard';
import { InjectRepository } from '@nestjs/typeorm';
import { UserResponse } from './interface/user-response.interface';
import { AuthGuard } from 'src/auth/auth.guard';


@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService,
    ) {}


  @Get('me')
  @UseGuards(AuthGuard)  // Verify Firebase token
  async getMe(@Req() req): Promise<User> {
    const id = req.user.uid;
    return await this.usersService.getMe(id);
  }

  @Put('me')
  @UseGuards(AuthGuard)
  async updateMe(@Req() req, @Body() updateUserDto: UpdateUserDto): Promise<User> {
    const id = req.user.uid;
    return await this.usersService.updateMe(id, updateUserDto);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Permissions(Permission.USER.CREATE)
  async create(@Body() createUserDto: CreateUserDto) {
    return await this.usersService.create(createUserDto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Permissions(Permission.USER.READ)
  async findAll(): Promise<UserResponse[]> {
    return await this.usersService.findAll();
  }  

  @Get(':id')
  @UseGuards(RolesGuard)
  @Permissions(Permission.USER.READ)
  async findOne(@Param('id') id: string) {
    return await this.usersService.findOne(id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Permissions(Permission.USER.WRITE)
  async update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return await this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Permissions(Permission.USER.DELETE)
  async remove(@Param('id') id: string) {
    return await this.usersService.remove(id);
  }

}



