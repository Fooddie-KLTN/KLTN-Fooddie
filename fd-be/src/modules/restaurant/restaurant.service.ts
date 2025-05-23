import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Restaurant, RestaurantStatus } from 'src/entities/restaurant.entity';
import { CreateRestaurantDto } from './dto/create-restaurant.dto';
import { UpdateRestaurantDto } from './dto/update-restaurant.dto';
import { User } from 'src/entities/user.entity';
import { GoogleCloudStorageService } from 'src/gcs/gcs.service';
import { GeocodingService } from 'src/services/geocoding.service';
import { Address } from 'src/entities/address.entity';

@Injectable()
export class RestaurantService {
    private readonly logger = new Logger(RestaurantService.name);
    
    constructor(
        @InjectRepository(Restaurant)
        private restaurantRepository: Repository<Restaurant>,
        @InjectRepository(User)
        private userRepository: Repository<User>,
        @InjectRepository(Address)
        private addressRepository: Repository<Address>,
        private gcsService: GoogleCloudStorageService,
        private geocodingService: GeocodingService
    ) {}

    /**
     * Request to create a new restaurant with file uploads and address
     * 
     * @param createRestaurantDto Restaurant data
     * @param addressData Address data
     * @param avatarFile Avatar image file
     * @param backgroundFile Background image file
     * @param certificateFile Certificate image file
     * @returns The created restaurant
     */
    async requestRestaurantWithFiles(
        createRestaurantDto: CreateRestaurantDto,
        addressData: {
            street: string;
            ward: string;
            district: string;
            city: string;
        },
        avatarFile?: Express.Multer.File,
        backgroundFile?: Express.Multer.File,
        certificateFile?: Express.Multer.File,
    ): Promise<Restaurant> {
        try {
            // Check if owner exists
            if (!createRestaurantDto.ownerId) {
                throw new BadRequestException('Owner ID is required');
            }
            
            const owner = await this.userRepository.findOne({
                where: { id: createRestaurantDto.ownerId }
            });

            if (!owner) {
                throw new BadRequestException('Owner not found');
            }

            // Create address using frontend coordinates if available
            const address = this.addressRepository.create(addressData);

            // If frontend provides coordinates, use them directly
            if (createRestaurantDto.latitude && createRestaurantDto.longitude) {
                address.latitude = parseFloat(createRestaurantDto.latitude);
                address.longitude = parseFloat(createRestaurantDto.longitude);
            } else {
                // Otherwise, try geocoding with Mapbox service
                try {
                    const coordinates = await this.geocodingService.geocode(addressData);
                    if (coordinates) {
                        address.latitude = coordinates.lat;
                        address.longitude = coordinates.lng;
                        this.logger.log(`Geocoding successful for address: ${addressData.street}, ${addressData.city}`);
                    } else {
                        this.logger.warn(`Geocoding returned no results for address: ${addressData.street}, ${addressData.city}`);
                    }
                } catch (geoError) {
                    this.logger.error(`Geocoding failed: ${geoError.message}`, geoError.stack);
                    // Just continue without coordinates
                }
            }

            // Save address even without coordinates
            await this.addressRepository.save(address);

            // Upload files to GCS if provided
            let avatarUrl = '';
            let backgroundUrl = '';
            let certificateUrl = '';
            
            try {
                // Upload avatar if provided
                if (avatarFile) {
                    avatarUrl = await this.gcsService.uploadPublicFile(avatarFile, 'restaurant-avatars');
                }
                
                // Upload background image if provided
                if (backgroundFile) {
                    backgroundUrl = await this.gcsService.uploadPublicFile(backgroundFile, 'restaurant-backgrounds');
                }
                
                // Upload certificate image if provided
                if (certificateFile) {
                    certificateUrl = await this.gcsService.uploadPublicFile(certificateFile, 'restaurant-certificates');
                }
            } catch (uploadError) {
                this.logger.error('Error uploading files:', uploadError);
                throw new BadRequestException(`File upload failed: ${uploadError.message}`);
            }
            
            // Create restaurant with uploaded image URLs and address
            const { latitude, longitude, ...restDto } = createRestaurantDto;
            const restaurant = this.restaurantRepository.create({
                ...restDto,
                latitude: latitude ? parseFloat(latitude) : undefined,
                longitude: longitude ? parseFloat(longitude) : undefined,
                avatar: avatarUrl,
                backgroundImage: backgroundUrl,
                certificateImage: certificateUrl,
                owner: owner,
                address: address,
                status: RestaurantStatus.APPROVED
            });

            return await this.restaurantRepository.save(restaurant);
        } catch (error) {
            if (error instanceof BadRequestException) {
                throw error;
            }
            throw new BadRequestException(`Failed to create restaurant: ${error.message}`);
        }
    }

    /**
     * Update a restaurant with file uploads
     * 
     * @param id Restaurant ID
     * @param updateRestaurantDto Updated restaurant data
     * @param avatarFile Avatar image file
     * @param backgroundFile Background image file
     * @param certificateFile Certificate image file
     * @returns The updated restaurant
     */
    async updateWithFiles(
        id: string,
        updateRestaurantDto: UpdateRestaurantDto,
        avatarFile?: Express.Multer.File,
        backgroundFile?: Express.Multer.File,
        certificateFile?: Express.Multer.File,
    ): Promise<Restaurant> {
        const restaurant = await this.findOne(id);
        if (!restaurant) {
            throw new NotFoundException(`Restaurant with ID ${id} not found`);
        }

        // Handle owner update if provided
        if (updateRestaurantDto.ownerId) {
            const owner = await this.userRepository.findOne({
                where: { id: updateRestaurantDto.ownerId }
            });

            if (!owner) {
                throw new BadRequestException('Owner not found');
            }

            restaurant.owner = owner;
            delete updateRestaurantDto.ownerId;
        }

        // Track old images to clean up after successful update
        const oldAvatarUrl = restaurant.avatar;
        const oldBackgroundUrl = restaurant.backgroundImage;
        const oldCertificateUrl = restaurant.certificateImage;

        try {
            // Upload new images if provided
            if (avatarFile) {
                restaurant.avatar = await this.gcsService.uploadPublicFile(avatarFile, 'restaurant-avatars');
            }
            
            if (backgroundFile) {
                restaurant.backgroundImage = await this.gcsService.uploadPublicFile(backgroundFile, 'restaurant-backgrounds');
            }
            
            if (certificateFile) {
                restaurant.certificateImage = await this.gcsService.uploadPublicFile(certificateFile, 'restaurant-certificates');
            }

            // Update restaurant with remaining fields
            Object.assign(restaurant, updateRestaurantDto);

            // Save updated restaurant
            const updatedRestaurant = await this.restaurantRepository.save(restaurant);
            
            // Clean up old images if they were replaced
            if (avatarFile && oldAvatarUrl) {
                await this.gcsService.deleteFile(oldAvatarUrl);
            }
            
            if (backgroundFile && oldBackgroundUrl) {
                await this.gcsService.deleteFile(oldBackgroundUrl);
            }
            
            if (certificateFile && oldCertificateUrl) {
                await this.gcsService.deleteFile(oldCertificateUrl);
            }

            return updatedRestaurant;
        } catch (error) {
            throw new BadRequestException(`Failed to update restaurant: ${error.message}`);
        }
    }

    /**
     * Update restaurant with address and handle geocoding failures gracefully
     */
    async updateWithAddressAndFiles(
        id: string,
        updateRestaurantDto: UpdateRestaurantDto,
        addressData?: {
            street: string;
            ward: string;
            district: string;
            city: string;
        },
        avatarFile?: Express.Multer.File,
        backgroundFile?: Express.Multer.File,
        certificateFile?: Express.Multer.File,
    ): Promise<Restaurant> {
        const restaurant = await this.findOne(id);
        if (!restaurant) {
            throw new NotFoundException(`Restaurant with ID ${id} not found`);
        }

        // Handle owner update if provided
        if (updateRestaurantDto.ownerId) {
            const owner = await this.userRepository.findOne({
                where: { id: updateRestaurantDto.ownerId }
            });

            if (!owner) {
                throw new BadRequestException('Owner not found');
            }

            restaurant.owner = owner;
            delete updateRestaurantDto.ownerId;
        }

        // Handle address update if provided
        if (addressData) {
            let address: Address;
            
            // Update existing address or create new one
            if (restaurant.address) {
                address = restaurant.address;
                Object.assign(address, addressData);
            } else {
                address = this.addressRepository.create(addressData);
            }
            
            try {
                // Try to get coordinates, but don't block if it fails
                const coordinates = await this.geocodingService.geocode(addressData);
                if (coordinates) {
                    address.latitude = coordinates.lat;
                    address.longitude = coordinates.lng;
                    this.logger.log(`Geocoding successful for address: ${addressData.street}, ${addressData.city}`);
                } else {
                    this.logger.warn(`Geocoding returned no results for address: ${addressData.street}, ${addressData.city}`);
                }
            } catch (geoError) {
                // Log the error but continue without geocoding
                this.logger.error(`Geocoding failed: ${geoError.message}`, geoError.stack);
                // We'll proceed without coordinates - no need to rethrow
            }
            
            // Save the address
            await this.addressRepository.save(address);
            restaurant.address = address;
        }

        // The rest of the update logic remains the same
        // Track old images to clean up after successful update
        const oldAvatarUrl = restaurant.avatar;
        const oldBackgroundUrl = restaurant.backgroundImage;
        const oldCertificateUrl = restaurant.certificateImage;

        try {
            // Upload new images if provided
            if (avatarFile) {
                restaurant.avatar = await this.gcsService.uploadPublicFile(avatarFile, 'restaurant-avatars');
            }
            
            if (backgroundFile) {
                restaurant.backgroundImage = await this.gcsService.uploadPublicFile(backgroundFile, 'restaurant-backgrounds');
            }
            
            if (certificateFile) {
                restaurant.certificateImage = await this.gcsService.uploadPublicFile(certificateFile, 'restaurant-certificates');
            }

            // Update restaurant with remaining fields
            Object.assign(restaurant, updateRestaurantDto);

            // Save updated restaurant
            const updatedRestaurant = await this.restaurantRepository.save(restaurant);
            
            // Clean up old images if they were replaced
            if (avatarFile && oldAvatarUrl) {
                await this.gcsService.deleteFile(oldAvatarUrl).catch(err => {
                    this.logger.warn(`Failed to delete old avatar: ${err.message}`);
                });
            }
            
            if (backgroundFile && oldBackgroundUrl) {
                await this.gcsService.deleteFile(oldBackgroundUrl).catch(err => {
                    this.logger.warn(`Failed to delete old background image: ${err.message}`);
                });
            }
            
            if (certificateFile && oldCertificateUrl) {
                await this.gcsService.deleteFile(oldCertificateUrl).catch(err => {
                    this.logger.warn(`Failed to delete old certificate: ${err.message}`);
                });
            }

            return updatedRestaurant;
        } catch (error) {
            throw new BadRequestException(`Failed to update restaurant: ${error.message}`);
        }
    }

    /**
     * Create a new restaurant
     * 
     * @param createRestaurantDto The restaurant data to create
     * @returns The created restaurant
     */
    async create(createRestaurantDto: CreateRestaurantDto): Promise<Restaurant> {
        try {
            // Check if owner exists
            if (createRestaurantDto.ownerId) {
                const owner = await this.userRepository.findOne({
                    where: { id: createRestaurantDto.ownerId }
                });

                if (!owner) {
                    throw new Error('Owner not found');
                }

                // Create restaurant object without address property first
                const { address: addressString, latitude, longitude, ...restaurantData } = createRestaurantDto;
                
                // Create new restaurant
                const restaurant = this.restaurantRepository.create({
                    ...restaurantData,
                    latitude: latitude ? parseFloat(latitude) : undefined,
                    longitude: longitude ? parseFloat(longitude) : undefined,
                    owner: owner,
                    status: RestaurantStatus.APPROVED
                });

                // If address string is provided, create an Address entity
                if (addressString) {
                    const address = this.addressRepository.create({
                        street: addressString
                    });
                    await this.addressRepository.save(address);
                    restaurant.address = address;
                }

                return await this.restaurantRepository.save(restaurant);
            } else {
                throw new Error('Owner ID is required');
            }
        } catch (error) {
            throw new Error(`Failed to create restaurant: ${error.message}`);
        }
    }

    /**
   * Request to create a new restaurant (pending approval)
   * 
   * @param createRestaurantDto The restaurant data to create
   * @returns The created restaurant request
   */
    async requestRestaurant(createRestaurantDto: CreateRestaurantDto): Promise<Restaurant> {
        try {
            // Check if owner exists
            if (createRestaurantDto.ownerId) {
                const owner = await this.userRepository.findOne({
                    where: { id: createRestaurantDto.ownerId }
                });

                if (!owner) {
                    throw new BadRequestException('Owner not found');
                }

                // Extract address from DTO
                const { address: addressString, ownerId, ...restaurantData } = createRestaurantDto;
                
                // Parse latitude and longitude to numbers if they exist
                const { latitude, longitude, ...rest } = restaurantData;
                
                // Create new restaurant request
                const restaurant = this.restaurantRepository.create({
                    ...rest,
                    latitude: latitude ? parseFloat(latitude) : undefined,
                    longitude: longitude ? parseFloat(longitude) : undefined,
                    owner: owner,
                    status: RestaurantStatus.PENDING
                });

                // If address string is provided, create an Address entity
                if (addressString) {
                    const address = this.addressRepository.create({
                        street: addressString
                    });
                    await this.addressRepository.save(address);
                    restaurant.address = address;
                }

                return await this.restaurantRepository.save(restaurant);
            } else {
                throw new BadRequestException('Owner ID is required');
            }
        } catch (error) {
            if (error instanceof BadRequestException) {
                throw error;
            }
            throw new BadRequestException(`Failed to request restaurant: ${error.message}`);
        }
    }

    /**
 * Get all restaurant requests (pending status)
 * 
 * @returns List of pending restaurant requests
 */
    async getRestaurantRequests(page = 1, pageSize = 10): Promise<{
        items: Restaurant[];
        totalItems: number;
        page: number;
        pageSize: number;
        totalPages: number;
    }> {
        const [items, totalItems] = await this.restaurantRepository.findAndCount({
            where: { status: RestaurantStatus.PENDING },
            relations: ['owner'],
            skip: (page - 1) * pageSize,
            take: pageSize,
        });

        return {
            items,
            totalItems,
            page,
            pageSize,
            totalPages: Math.ceil(totalItems / pageSize),
        };
    }



    /**
     * Delete a restaurant request
     * 
     * @param id The restaurant request ID to delete
     */
    async deleteRestaurantRequest(id: string): Promise<void> {
        const restaurant = await this.findOne(id);

        if (restaurant.status !== RestaurantStatus.PENDING) {
            throw new BadRequestException(`Restaurant with ID ${id} is not a pending request`);
        }

        const result = await this.restaurantRepository.delete(id);

        if (result.affected === 0) {
            throw new NotFoundException(`Restaurant request with ID ${id} not found`);
        }
    }

    /**
* Approve a restaurant request
* 
* @param id The restaurant ID to approve
* @returns The approved restaurant
*/
    async approveRestaurant(id: string): Promise<Restaurant> {
        const restaurant = await this.findOne(id);

        if (restaurant.status !== RestaurantStatus.PENDING) {
            throw new BadRequestException(`Restaurant with ID ${id} is not in pending status`);
        }

        restaurant.status = RestaurantStatus.APPROVED;
        return await this.restaurantRepository.save(restaurant);
    }



    /**
     * Reject a restaurant request
     * 
     * @param id The restaurant ID to reject
     * @returns The rejected restaurant
     */
    async rejectRestaurant(id: string): Promise<Restaurant> {
        const restaurant = await this.findOne(id);

        if (restaurant.status !== RestaurantStatus.PENDING) {
            throw new BadRequestException(`Restaurant with ID ${id} is not in pending status`);
        }

        restaurant.status = RestaurantStatus.REJECTED;
        return await this.restaurantRepository.save(restaurant);
    }

    /**
  * Get approved restaurants only
  * 
  * @returns List of all approved restaurants
  */
    async findAllApproved(page = 1, pageSize = 10): Promise<{
        items: Restaurant[];
        totalItems: number;
        page: number;
        pageSize: number;
        totalPages: number;
    }> {
        const [items, totalItems] = await this.restaurantRepository.findAndCount({
            where: { status: RestaurantStatus.APPROVED },
            relations: ['owner'],
            skip: (page - 1) * pageSize,
            take: pageSize,
        });

        return {
            items,
            totalItems,
            page,
            pageSize,
            totalPages: Math.ceil(totalItems / pageSize),
        };
    }

    /**
     * Get all restaurants
     * 
     * @returns List of all restaurants
     */
    async findAll(page = 1, pageSize = 10): Promise<{
        items: Restaurant[];
        totalItems: number;
        page: number;
        pageSize: number;
        totalPages: number;
    }> {
        const [items, totalItems] = await this.restaurantRepository.findAndCount({
            relations: ['owner'],
            skip: (page - 1) * pageSize,
            take: pageSize,
        });

        return {
            items,
            totalItems,
            page,
            pageSize,
            totalPages: Math.ceil(totalItems / pageSize),
        };
    }

    /**
     * Get restaurant preview list with limited information
     * 
     * @returns List of restaurants with basic information
     */
    async getPreview(page = 1, pageSize = 10): Promise<{
        items: Partial<Restaurant>[];
        totalItems: number;
        page: number;
        pageSize: number;
        totalPages: number;
    }> {
        const queryBuilder = this.restaurantRepository
            .createQueryBuilder('restaurant')
            .select([
                'restaurant.id',
                'restaurant.name',
                'restaurant.address',
                'restaurant.avatar',
                'restaurant.description',
                'restaurant.openTime',
                'restaurant.closeTime',
            ]);

        const totalItems = await queryBuilder.getCount();

        const items = await queryBuilder
            .skip((page - 1) * pageSize)
            .take(pageSize)
            .getMany();

        return {
            items,
            totalItems,
            page,
            pageSize,
            totalPages: Math.ceil(totalItems / pageSize),
        };
    }

    /**
     * Get a specific restaurant by ID
     * 
     * @param id The restaurant ID
     * @returns The restaurant details
     */
    async findOne(id: string): Promise<Restaurant> {
        const restaurant = await this.restaurantRepository.findOne({
            where: { id },
            relations: ['owner', 'foods']
        });

        if (!restaurant) {
            throw new Error(`Restaurant with ID ${id} not found`);
        }

        return restaurant;
    }

    /**
     * Get a restaurant by ownerId
     * @param ownerId The owner's user ID
     * @returns The restaurant owned by the user
     */
    async findByOwnerId(ownerId: string): Promise<Restaurant | null> {
        const restaurant = await this.restaurantRepository.findOne({
            where: { owner: { id: ownerId } },
            relations: ['owner', 'foods']
        });
        return restaurant || null;
    }

    /**
     * Update a restaurant
     * 
     * @param id The restaurant ID
     * @param updateRestaurantDto The updated restaurant data
     * @returns The updated restaurant
     */
    async update(id: string, updateRestaurantDto: UpdateRestaurantDto): Promise<Restaurant> {
        const restaurant = await this.findOne(id);

        // Handle owner update if provided
        if (updateRestaurantDto.ownerId) {
            const owner = await this.userRepository.findOne({
                where: { id: updateRestaurantDto.ownerId }
            });

            if (!owner) {
                throw new Error('Owner not found');
            }

            restaurant.owner = owner;
            // Remove ownerId from DTO to prevent TypeORM errors
            delete updateRestaurantDto.ownerId;
        }

        // Update restaurant with remaining fields
        Object.assign(restaurant, updateRestaurantDto);

        return await this.restaurantRepository.save(restaurant);
    }

    /**
     * Delete a restaurant
     * 
     * @param id The restaurant ID
     */
    async remove(id: string): Promise<void> {
        const result = await this.restaurantRepository.delete(id);

        if (result.affected === 0) {
            throw new Error(`Restaurant with ID ${id} not found`);
        }
    }

    async getOrderCountByOwner(ownerId: string, month?: string): Promise<number> {
        const restaurant = await this.findByOwnerId(ownerId);
        if (!restaurant) throw new Error('No restaurant found for this owner');
        // Implement your logic to count orders for this restaurant in the given month
        // Example:
        // return this.orderRepository.count({ where: { restaurant: { id: restaurant.id }, createdAt: ... } });
        return 0; // Replace with real logic
    }

    async getRevenueByOwner(ownerId: string, month?: string): Promise<number> {
        const restaurant = await this.findByOwnerId(ownerId);
        if (!restaurant) throw new Error('No restaurant found for this owner');
        // Implement your logic to sum revenue for this restaurant in the given month
        // Example:
        // return this.orderRepository.sum('total', { where: { restaurant: { id: restaurant.id }, createdAt: ... } });
        return 0; // Replace with real logic
    }
}